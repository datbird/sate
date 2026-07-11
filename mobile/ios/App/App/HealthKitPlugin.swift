import Foundation
import Capacitor
import HealthKit

// Sate — minimal read-only HealthKit bridge.
//
// The web app (loaded remotely in the webview) calls this over the Capacitor native bridge to
// pull recent workouts and their Apple-computed Active Energy, then POSTs them to the Sate
// backend for dedup + import. Read-only: Sate never writes to Health. Registered automatically
// because it is an @objc CAPPlugin/CAPBridgedPlugin compiled into the app target.
@objc(HealthKitPlugin)
public class HealthKitPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HealthKitPlugin"
    public let jsName = "HealthKit"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAuthorization", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "queryWorkouts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "queryHeartRate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "queryBodyStats", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "queryWeights", returnType: CAPPluginReturnPromise),
    ]

    private let store = HKHealthStore()

    private var readTypes: Set<HKObjectType> {
        var t: Set<HKObjectType> = [HKObjectType.workoutType()]
        if let e = HKObjectType.quantityType(forIdentifier: .activeEnergyBurned) { t.insert(e) }
        if let d = HKObjectType.quantityType(forIdentifier: .distanceWalkingRunning) { t.insert(d) }
        if let c = HKObjectType.quantityType(forIdentifier: .distanceCycling) { t.insert(c) }
        // "Add from heart rate" needs the HR series plus the body stats the Keytel formula uses.
        if let hr = HKObjectType.quantityType(forIdentifier: .heartRate) { t.insert(hr) }
        if let m = HKObjectType.quantityType(forIdentifier: .bodyMass) { t.insert(m) }
        if let dob = HKObjectType.characteristicType(forIdentifier: .dateOfBirth) { t.insert(dob) }
        if let sex = HKObjectType.characteristicType(forIdentifier: .biologicalSex) { t.insert(sex) }
        return t
    }

    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": HKHealthStore.isHealthDataAvailable()])
    }

    @objc func requestAuthorization(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else {
            call.resolve(["granted": false, "available": false])
            return
        }
        store.requestAuthorization(toShare: nil, read: readTypes) { success, error in
            if let error = error {
                call.reject("Health authorization failed: \(error.localizedDescription)")
                return
            }
            // iOS never reveals read-permission status, so `success` only means the sheet
            // completed. Treat that as connected; a later empty query is not an error.
            call.resolve(["granted": success, "available": true])
        }
    }

    @objc func queryWorkouts(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else {
            call.resolve(["workouts": []])
            return
        }
        let days = call.getInt("days") ?? 30
        let start = Calendar.current.date(byAdding: .day, value: -max(1, days), to: Date()) ?? Date()
        let predicate = HKQuery.predicateForSamples(withStart: start, end: Date(), options: .strictStartDate)
        let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)

        let query = HKSampleQuery(sampleType: HKObjectType.workoutType(), predicate: predicate,
                                  limit: 200, sortDescriptors: [sort]) { [weak self] _, samples, error in
            if let error = error {
                call.reject("Workout query failed: \(error.localizedDescription)")
                return
            }
            let iso = ISO8601DateFormatter()
            let workouts: [[String: Any]] = (samples as? [HKWorkout] ?? []).map { w in
                let kcal = w.totalEnergyBurned?.doubleValue(for: .kilocalorie()) ?? 0
                let meters = w.totalDistance?.doubleValue(for: .meter()) ?? 0
                return [
                    "id": w.uuid.uuidString,
                    "name": self?.name(for: w.workoutActivityType) ?? "Workout",
                    "start": iso.string(from: w.startDate),
                    "end": iso.string(from: w.endDate),
                    "duration_min": w.duration / 60.0,
                    "kcal": kcal,
                    "distance_m": meters,
                ]
            }
            call.resolve(["workouts": workouts])
        }
        store.execute(query)
    }

    // Heart-rate series for the last `hours` (default 24), ascending, downsampled to ≤ ~500
    // points so the graph payload stays small. Each point is { t: ISO8601, bpm: Int }.
    @objc func queryHeartRate(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable(),
              let hrType = HKObjectType.quantityType(forIdentifier: .heartRate) else {
            call.resolve(["samples": []])
            return
        }
        let hours = call.getInt("hours") ?? 24
        let start = Calendar.current.date(byAdding: .hour, value: -max(1, hours), to: Date()) ?? Date()
        let predicate = HKQuery.predicateForSamples(withStart: start, end: Date(), options: .strictStartDate)
        let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)

        let query = HKSampleQuery(sampleType: hrType, predicate: predicate,
                                  limit: HKObjectQueryNoLimit, sortDescriptors: [sort]) { _, samples, error in
            if let error = error {
                call.reject("Heart-rate query failed: \(error.localizedDescription)")
                return
            }
            let unit = HKUnit.count().unitDivided(by: .minute())
            let iso = ISO8601DateFormatter()
            let all = (samples as? [HKQuantitySample]) ?? []
            let stride = max(1, all.count / 500)
            var out: [[String: Any]] = []
            var i = 0
            while i < all.count {
                let s = all[i]
                out.append([
                    "t": iso.string(from: s.startDate),
                    "bpm": Int(s.quantity.doubleValue(for: unit).rounded()),
                ])
                i += stride
            }
            call.resolve(["samples": out])
        }
        store.execute(query)
    }

    // Weight (kg), age (yr), and sex for the HR→kcal formula. Any value Apple Health doesn't
    // have comes back null; the web layer then falls back to the profile or asks the user.
    @objc func queryBodyStats(_ call: CAPPluginCall) {
        var result: [String: Any] = ["weight_kg": NSNull(), "age": NSNull(), "sex": NSNull()]

        if let dob = try? store.dateOfBirthComponents(), let birthYear = dob.year {
            let now = Calendar.current.dateComponents([.year, .month, .day], from: Date())
            if let nowYear = now.year {
                var age = nowYear - birthYear
                if let bm = dob.month, let bd = dob.day, let nm = now.month, let nd = now.day,
                   (nm < bm || (nm == bm && nd < bd)) { age -= 1 }
                if age > 0 && age < 130 { result["age"] = age }
            }
        }
        if let sex = try? store.biologicalSex() {
            switch sex.biologicalSex {
            case .male: result["sex"] = "male"
            case .female: result["sex"] = "female"
            default: break
            }
        }

        guard HKHealthStore.isHealthDataAvailable(),
              let massType = HKObjectType.quantityType(forIdentifier: .bodyMass) else {
            call.resolve(result)
            return
        }
        let sort = NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)
        let query = HKSampleQuery(sampleType: massType, predicate: nil, limit: 1, sortDescriptors: [sort]) { _, samples, _ in
            if let s = (samples as? [HKQuantitySample])?.first {
                result["weight_kg"] = s.quantity.doubleValue(for: .gramUnit(with: .kilo))
            }
            call.resolve(result)
        }
        store.execute(query)
    }

    // Body-mass (weight) samples over the last `months` (default 12), ascending, downsampled to
    // ≤ ~400 points. `id` is the sample UUID so a re-sync dedupes. kg via the kilogram unit.
    @objc func queryWeights(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable(),
              let massType = HKObjectType.quantityType(forIdentifier: .bodyMass) else {
            call.resolve(["samples": []])
            return
        }
        let months = call.getInt("months") ?? 12
        let start = Calendar.current.date(byAdding: .month, value: -max(1, months), to: Date()) ?? Date()
        let predicate = HKQuery.predicateForSamples(withStart: start, end: Date(), options: .strictStartDate)
        let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)

        let query = HKSampleQuery(sampleType: massType, predicate: predicate,
                                  limit: HKObjectQueryNoLimit, sortDescriptors: [sort]) { _, samples, error in
            if let error = error {
                call.reject("Weight query failed: \(error.localizedDescription)")
                return
            }
            let iso = ISO8601DateFormatter()
            let all = (samples as? [HKQuantitySample]) ?? []
            let stride = max(1, all.count / 400)
            var out: [[String: Any]] = []
            var i = 0
            while i < all.count {
                let s = all[i]
                out.append([
                    "id": s.uuid.uuidString,
                    "date": iso.string(from: s.startDate),
                    "kg": s.quantity.doubleValue(for: .gramUnit(with: .kilo)),
                ])
                i += stride
            }
            call.resolve(["samples": out])
        }
        store.execute(query)
    }

    // Human-readable name for the common workout types; falls back to "Workout".
    private func name(for type: HKWorkoutActivityType) -> String {
        switch type {
        case .running: return "Run"
        case .walking: return "Walk"
        case .hiking: return "Hike"
        case .cycling: return "Cycling"
        case .swimming: return "Swim"
        case .traditionalStrengthTraining, .functionalStrengthTraining: return "Strength Training"
        case .highIntensityIntervalTraining: return "HIIT"
        case .yoga: return "Yoga"
        case .pilates: return "Pilates"
        case .elliptical: return "Elliptical"
        case .rowing: return "Rowing"
        case .stairClimbing, .stairs: return "Stair Climbing"
        case .coreTraining: return "Core Training"
        case .dance, .cardioDance: return "Dance"
        case .kickboxing, .boxing: return "Boxing"
        case .jumpRope: return "Jump Rope"
        case .cooldown: return "Cooldown"
        case .mixedCardio: return "Cardio"
        default: return "Workout"
        }
    }
}
