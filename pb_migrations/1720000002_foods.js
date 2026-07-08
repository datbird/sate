/// <reference path="../pb_data/types.d.ts" />

// Food knowledge base: a curated starter set the AI refers to (for consistent, grounded
// estimates) and grows into (auto-saving new foods as unverified). Additive migration.
//
// Seed rows are [name, brand, serving_desc, serving_g, kcal, protein, carbs, fat, category, aliases]
// Values are reasonable per-serving averages — a starting point, refined via the admin Food DB.

function normKey(name, brand) {
  const n = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  return n(name) + "|" + n(brand);
}

migrate(
  (app) => {
    const foods = new Collection({
      type: "base",
      name: "foods",
      fields: [
        { type: "text", name: "name", required: true, max: 200 },
        { type: "text", name: "brand", max: 120 },
        { type: "text", name: "serving_desc", max: 120 },
        { type: "number", name: "serving_g" },
        { type: "number", name: "kcal" },
        { type: "number", name: "protein" },
        { type: "number", name: "carbs" },
        { type: "number", name: "fat" },
        { type: "text", name: "category", max: 60 },
        { type: "json", name: "aliases", maxSize: 4000 },
        { type: "text", name: "barcode", max: 60 },
        { type: "text", name: "source" }, // seed | ai | user
        { type: "bool", name: "verified" },
        { type: "number", name: "usage_count" },
        { type: "text", name: "search", max: 600 }, // lowercased name+brand+aliases for lookup
        { type: "text", name: "norm_key", required: true, max: 300 },
        { type: "autodate", name: "created", onCreate: true },
        { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_foods_norm ON foods (norm_key)",
        "CREATE INDEX idx_foods_search ON foods (search)",
      ],
    });
    app.save(foods);

    const S = [
      // ---- eggs ----
      ["Boiled egg","","1 large (50g)",50,78,6,1,5,"eggs","hard boiled egg|hard-boiled egg|egg"],
      ["Fried egg","","1 large",46,90,6,0,7,"eggs","egg fried"],
      ["Scrambled eggs","","2 eggs w/ butter",120,200,13,2,15,"eggs","scrambled egg"],
      ["Deviled egg","","1 half",30,65,3,0,6,"eggs","devilled egg"],
      ["Cheese omelette","","3-egg with cheese",180,430,26,3,34,"eggs","omelet|omelette"],
      ["Egg white","","1 large",33,17,4,0,0,"eggs","egg whites"],
      // ---- bread & grains ----
      ["White bread","","1 slice",28,75,2,14,1,"grains","bread"],
      ["Whole wheat bread","","1 slice",28,80,4,14,1,"grains","wheat bread|brown bread"],
      ["Bagel","","1 plain",105,270,11,53,2,"grains","plain bagel"],
      ["White rice","","1 cup cooked",158,205,4,45,0,"grains","steamed rice|rice"],
      ["Brown rice","","1 cup cooked",195,215,5,45,2,"grains","brown rice cooked"],
      ["Pasta","","1 cup cooked",140,220,8,43,1,"grains","spaghetti|noodles|penne"],
      ["Oatmeal","","1 cup cooked",234,160,6,27,3,"grains","porridge|oats"],
      ["Quinoa","","1 cup cooked",185,222,8,39,4,"grains",""],
      ["Tortilla (flour)","","1 medium 8in",49,150,4,25,4,"grains","flour tortilla"],
      // ---- dishes ----
      ["Mac and cheese","","1 cup homemade",200,375,15,42,17,"dishes","macaroni and cheese|mac n cheese"],
      ["Kraft Mac & Cheese","Kraft","1 cup prepared",198,350,10,47,13,"dishes","kraft macaroni|kraft mac and cheese"],
      ["Instant ramen","","1 packet prepared",300,380,8,52,14,"dishes","ramen noodles|cup noodles|top ramen"],
      ["Tonkotsu ramen bowl","","1 restaurant bowl",600,650,30,70,26,"dishes","ramen bowl|pork ramen"],
      ["Spaghetti with marinara","","1 plate",300,340,12,58,7,"dishes","spaghetti marinara|pasta with sauce"],
      ["Spaghetti bolognese","","1 plate",350,520,24,60,20,"dishes","spaghetti meat sauce|bolognese"],
      ["Cheese pizza slice","","1 slice",107,285,12,36,10,"dishes","pizza|plain pizza"],
      ["Pepperoni pizza slice","","1 slice",111,310,13,35,13,"dishes","pepperoni pizza"],
      ["Grilled cheese","","1 sandwich",120,400,16,33,23,"dishes","grilled cheese sandwich"],
      ["PB&J sandwich","","1 sandwich",130,380,12,50,15,"dishes","peanut butter and jelly|pbj"],
      ["Caesar salad","","1 bowl no chicken",160,320,7,12,28,"dishes","cesar salad"],
      ["Chicken Caesar salad","","1 bowl",300,470,35,14,30,"dishes","chicken caesar"],
      ["Beef taco","","1 taco",100,210,9,15,12,"dishes","taco"],
      ["Bean & cheese burrito","","1 burrito",200,380,13,50,14,"dishes","burrito|bean burrito"],
      ["Chicken burrito","","1 large",380,650,32,70,25,"dishes","burrito chicken"],
      ["California roll","","6 pieces",170,255,9,38,7,"dishes","sushi roll|california sushi"],
      ["Fried rice","","1 cup",198,330,12,42,12,"dishes","chicken fried rice"],
      ["Pad thai","","1 plate",300,600,20,70,24,"dishes",""],
      ["Chicken tikka masala","","1 cup w/o rice",250,340,25,12,20,"dishes","tikka masala"],
      ["Beef chili","","1 cup",250,290,22,22,13,"dishes","chili|chili con carne"],
      ["Chicken noodle soup","","1 cup",245,120,8,12,4,"dishes","noodle soup"],
      ["Hamburger","","1 fast food",110,255,13,30,9,"dishes","burger"],
      ["Cheeseburger","","1 fast food",120,300,15,33,14,"dishes","cheese burger"],
      ["Hot dog","","1 with bun",100,290,10,24,17,"dishes","hotdog"],
      // ---- proteins ----
      ["Grilled chicken breast","","4 oz cooked",113,185,35,0,4,"protein","chicken breast|chicken"],
      ["Chicken thigh","","1 cooked skinless",52,110,13,0,6,"protein",""],
      ["Ground beef 80/20","","4 oz cooked",113,290,26,0,20,"protein","hamburger meat|ground beef"],
      ["Ribeye steak","","6 oz cooked",170,480,42,0,34,"protein","steak|ribeye"],
      ["Baked salmon","","4 oz",113,235,25,0,14,"protein","salmon"],
      ["Canned tuna","","1 can in water",142,130,29,0,1,"protein","tuna"],
      ["Shrimp","","3 oz cooked",85,85,20,0,1,"protein","prawns"],
      ["Bacon","","2 slices",16,90,6,0,7,"protein",""],
      ["Pork sausage","","1 link",25,90,5,0,8,"protein","sausage"],
      ["Tofu","","1/2 cup firm",126,180,20,4,11,"protein",""],
      ["Black beans","","1 cup",172,227,15,41,1,"protein","beans"],
      ["Lentils","","1 cup cooked",198,230,18,40,1,"protein",""],
      ["Turkey deli slice","","2 oz",56,60,10,1,1,"protein","deli turkey|sliced turkey"],
      // ---- dairy ----
      ["Whole milk","","1 cup",244,150,8,12,8,"dairy","milk"],
      ["2% milk","","1 cup",244,120,8,12,5,"dairy","reduced fat milk"],
      ["Skim milk","","1 cup",245,85,8,12,0,"dairy","nonfat milk"],
      ["Cheddar cheese","","1 oz slice",28,115,7,0,9,"dairy","cheddar|cheese"],
      ["American cheese","","1 slice",21,65,3,1,5,"dairy","american slice"],
      ["Greek yogurt (plain)","","1 cup nonfat",245,130,22,9,0,"dairy","greek yogurt"],
      ["Flavored yogurt","","1 cup",245,200,9,32,4,"dairy","yogurt"],
      ["Butter","","1 tbsp",14,100,0,0,11,"dairy",""],
      ["Cream cheese","","1 tbsp",15,50,1,1,5,"dairy",""],
      ["Cottage cheese","","1 cup",226,180,25,8,5,"dairy",""],
      // ---- fruits ----
      ["Apple","","1 medium",182,95,0,25,0,"fruit",""],
      ["Banana","","1 medium",118,105,1,27,0,"fruit",""],
      ["Orange","","1 medium",131,62,1,15,0,"fruit",""],
      ["Grapes","","1 cup",151,104,1,27,0,"fruit",""],
      ["Strawberries","","1 cup",152,49,1,12,0,"fruit","strawberry"],
      ["Blueberries","","1 cup",148,85,1,21,0,"fruit","blueberry"],
      ["Watermelon","","1 cup diced",152,46,1,12,0,"fruit",""],
      ["Avocado","","1/2 medium",100,160,2,9,15,"fruit",""],
      ["Mango","","1 cup sliced",165,99,1,25,0,"fruit",""],
      // ---- vegetables ----
      ["Broccoli","","1 cup cooked",156,55,4,11,1,"vegetable",""],
      ["Carrots","","1 cup chopped",128,52,1,12,0,"vegetable","carrot"],
      ["Spinach","","1 cup raw",30,7,1,1,0,"vegetable",""],
      ["Side salad","","1 small w/o dressing",100,20,1,4,0,"vegetable","garden salad"],
      ["Baked potato","","1 medium plain",173,160,4,37,0,"vegetable","potato"],
      ["Mashed potatoes","","1 cup",210,240,4,35,9,"vegetable",""],
      ["French fries","","1 medium fast food",117,365,4,48,17,"vegetable","fries"],
      ["Sweet potato","","1 medium baked",114,100,2,23,0,"vegetable",""],
      ["Corn","","1 cup",145,130,5,29,2,"vegetable",""],
      // ---- snacks & sweets ----
      ["Potato chips","","1 oz (~15)",28,150,2,15,10,"snacks","chips|crisps"],
      ["Tortilla chips","","1 oz",28,140,2,18,7,"snacks",""],
      ["Popcorn","","3 cups air-popped",24,90,3,18,1,"snacks",""],
      ["Almonds","","1 oz (~23)",28,165,6,6,14,"snacks","almond"],
      ["Peanut butter","","2 tbsp",32,190,7,7,16,"snacks","pb"],
      ["Granola bar","","1 bar",40,190,4,29,7,"snacks",""],
      ["Protein bar","","1 bar",60,220,20,23,7,"snacks",""],
      ["Chocolate chip cookie","","1 medium",30,150,2,20,7,"snacks","cookie"],
      ["Brownie","","1 square",56,230,3,32,11,"snacks",""],
      ["Ice cream","","1/2 cup vanilla",66,140,2,16,7,"snacks",""],
      ["Glazed donut","","1",60,240,4,26,14,"snacks","doughnut|donut"],
      ["Dark chocolate","","1 oz",28,170,2,13,12,"snacks","chocolate"],
      // ---- fast food specifics ----
      ["Big Mac","McDonald's","1 burger",219,590,25,46,34,"fast food","mcdonalds big mac"],
      ["Medium Fries","McDonald's","1 medium",117,320,4,43,15,"fast food","mcdonalds fries"],
      ["McChicken","McDonald's","1 sandwich",143,400,14,39,21,"fast food",""],
      ["Whopper","Burger King","1 burger",270,660,28,49,40,"fast food",""],
      ["Chicken Sandwich","Chick-fil-A","1 sandwich",183,420,29,41,18,"fast food","chick fil a sandwich"],
      ["Chicken Burrito Bowl","Chipotle","1 bowl avg",400,700,40,60,25,"fast food","chipotle bowl"],
      ["6in Turkey Sub","Subway","1 sandwich",219,280,18,46,4,"fast food","subway turkey"],
      // ---- breakfast ----
      ["Pancakes","","2 with syrup",232,520,8,90,12,"breakfast","pancake"],
      ["Waffle","","1 with syrup",100,310,6,50,9,"breakfast",""],
      ["French toast","","2 slices",130,360,10,40,16,"breakfast",""],
      ["Cereal with milk","","1 cup + 1/2 cup milk",180,230,7,42,4,"breakfast","cereal"],
      ["Hash browns","","1 patty",55,150,1,15,9,"breakfast","hashbrowns"],
      ["Breakfast burrito","","1",210,510,20,45,28,"breakfast",""],
      ["Bacon egg & cheese","","1 sandwich",150,450,20,35,25,"breakfast","bec|breakfast sandwich"],
      // ---- beverages ----
      ["Black coffee","","1 cup",240,2,0,0,0,"beverage","coffee"],
      ["Caffe latte","","16 oz whole milk",480,220,12,18,11,"beverage","latte"],
      ["Orange juice","","1 cup",248,110,2,26,0,"beverage","oj"],
      ["Coca-Cola","Coca-Cola","1 can (12oz)",355,140,0,39,0,"beverage","coke|cola|soda"],
      ["Diet Coke","Coca-Cola","1 can",355,0,0,0,0,"beverage","diet soda"],
      ["Beer","","12 oz",355,150,2,13,0,"beverage",""],
      ["Red wine","","5 oz",147,125,0,4,0,"beverage","wine"],
      ["Gatorade","Gatorade","20 oz",591,140,0,36,0,"beverage","sports drink"],
      ["Fruit smoothie","","16 oz",480,300,6,60,3,"beverage","smoothie"],
      ["Energy drink","","1 can (16oz)",473,210,0,54,0,"beverage",""],
      // ---- condiments ----
      ["Ketchup","","1 tbsp",17,20,0,5,0,"condiment",""],
      ["Mayonnaise","","1 tbsp",14,90,0,0,10,"condiment","mayo"],
      ["Ranch dressing","","2 tbsp",30,130,1,2,14,"condiment","ranch"],
      ["Olive oil","","1 tbsp",14,120,0,0,14,"condiment",""],
      ["Honey","","1 tbsp",21,64,0,17,0,"condiment",""],
      ["Maple syrup","","1 tbsp",20,52,0,13,0,"condiment","syrup"],
      ["Soy sauce","","1 tbsp",16,10,1,1,0,"condiment",""],
    ];

    const col = foods;
    for (const r of S) {
      const [name, brand, serving_desc, serving_g, kcal, protein, carbs, fat, category, aliasesStr] = r;
      const aliases = aliasesStr ? aliasesStr.split("|") : [];
      const rec = new Record(col);
      rec.set("name", name);
      rec.set("brand", brand);
      rec.set("serving_desc", serving_desc);
      rec.set("serving_g", serving_g);
      rec.set("kcal", kcal);
      rec.set("protein", protein);
      rec.set("carbs", carbs);
      rec.set("fat", fat);
      rec.set("category", category);
      rec.set("aliases", aliases);
      rec.set("source", "seed");
      rec.set("verified", true);
      rec.set("usage_count", 0);
      rec.set("search", (name + " " + brand + " " + aliases.join(" ")).toLowerCase());
      rec.set("norm_key", normKey(name, brand));
      app.save(rec);
    }
  },
  (app) => {
    try {
      app.delete(app.findCollectionByNameOrId("foods"));
    } catch (_) {}
  }
);
