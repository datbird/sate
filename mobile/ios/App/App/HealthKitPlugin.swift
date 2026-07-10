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
    ]

    private let store = HKHealthStore()

    private var readTypes: Set<HKObjectType> {
        var t: Set<HKObjectType> = [HKObjectType.workoutType()]
        if let e = HKObjectType.quantityType(forIdentifier: .activeEnergyBurned) { t.insert(e) }
        if let d = HKObjectType.quantityType(forIdentifier: .distanceWalkingRunning) { t.insert(d) }
        if let c = HKObjectType.quantityType(forIdentifier: .distanceCycling) { t.insert(c) }
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
