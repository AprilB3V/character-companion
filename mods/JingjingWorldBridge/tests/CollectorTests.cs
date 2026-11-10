using System;
using System.Collections.Generic;
using System.Reflection;
using JingjingWorldBridge;

// Minimal external game/Unity doubles: tests execute the production collector unchanged.
public interface IMod { void Init(ModManifest manifest); void OnEnable(); void OnDisable(); }
public class ModManifest { }
public interface GraphNodeStorage { List<GraphNodeStorage> children { get; } }
public class GameInventory : GraphNodeStorage
{
    public List<GraphNodeStorage> children { get; private set; }
    public GameInventory() { children = new List<GraphNodeStorage>(); }
}
public class GameItem : GraphNodeStorage
{
    public string identifier;
    public string name;
    public int unitCount = 1;
    public bool owned = true;
    public GraphNodeStorage child;
    public List<ItemFeature> itemFeatures = new List<ItemFeature>();
    public bool liquid;
    public int waterPurity;
    public List<GraphNodeStorage> children { get { throw new Exception("Inspection graph must not be traversed"); } }
    public string GetDisplayName(bool customName) { return name; }
    public bool IsTag(string tag) { return liquid && tag == "LIQUID_CONTAINER_TAG"; }
}
public class ItemCondition { public string display, identifier; public int modValue, compareValue; public bool hiddenAsPublic; }
public class ItemFeature
{
    public enum FeatureType { Normale, Event, Special, Temporary }
    public FeatureType featureType;
    public bool isDisabled, useCondition = true, exposed;
    public string category;
    public ItemCondition fakeCondition, realCondition;
    public string GetCategory() { return category; }
    public bool IsFeatureMatch() { return realCondition.identifier == fakeCondition.identifier; }
    public bool IsExposed() { return exposed; }
}
public static class WaterHelper
{
    public static bool IsEmpty(GameItem item) { return item.waterPurity == 0; }
    public static int GetWaterPurity(GameItem item) { return item.waterPurity; }
}
public static class GeneralHelper { public static bool IsItemOwned(GameItem item) { return item.owned; } }
public class EmporiumEntry : UnityEngine.Object
{
    public static EmporiumEntry Instance;
    public GameInventory invElement, frontInvinvElement, backInvinvElement, backInvinvElementCounter,
        showcaseElement, hiddenElement, docInvElement, cassettePlayerElement, vendingMachineElement,
        vendingFountainElement, hirelingInv, afterhourPocketSlotInvLeft, afterhourPocketSlotInvBackpack,
        afterhourPocketSlotInvRight;
}
public class NewGameData
{
    public static NewGameData Instance;
    public bool isInMainMenu, isShowcase;
}
public class PlayerStore
{
    public static bool HasInstance;
    public static PlayerStore instance;
    public static int accesses;
    public static PlayerStore Instance { get { accesses++; return instance; } }
    public int playerCash, saveSlotId;
    public string runID;
    public string playerLocation = "IN_STORE";
    public int rentValue;
    public SecData secData;
    public RunStats runStats;
    public List<StoreReputation> storeReputations;
    public bool isClientArrived;
    public StoreClientInstance currentClientInstance;
}
public class SecData { public int evidenceLevel; public int GetTotalCrimeValue() { return 17; } }
public class RunStats { public int rentPaid, augsShot; }
public class DialogUIManager { }
public class DialoguePhoneUIManager { }
public class StoreStation { public static StoreStation Instance; public int dayCounter; }
public class StoreReputation { public string factionId; public double GetReputationExact() { return 2; } }
public class StoreClient { public string identifier, displayName, clientFaction; public bool isSecurity; }
public class StoreClientInstance { public StoreClient client; public StoreClient GetClientBlueprint() { return client; } }
namespace HarmonyLib
{
    public class HarmonyPatch : Attribute { public HarmonyPatch(Type type, string name) { } }
    public class HarmonyPostfix : Attribute { }
}
namespace UnityEngine
{
    public class Object { public static void DontDestroyOnLoad(Object value) { } public static void Destroy(Object value) { } }
    public class MonoBehaviour : Object { }
    public class GameObject : Object
    {
        public GameObject(string name) { }
        public T AddComponent<T>() where T : new() { return new T(); }
    }
    public static class Time { public static float realtimeSinceStartup; }
    public static class Application { public static string dataPath; }
    public static class Debug { public static void LogWarning(object value) { } }
}
namespace Newtonsoft.Json { public static class JsonConvert { public static string SerializeObject(object value) { throw new NotSupportedException(); } } }

public static class CollectorTests
{
    private static Snapshot Capture()
    {
        return (Snapshot)typeof(SnapshotWriter).GetMethod("Capture", BindingFlags.NonPublic | BindingFlags.Instance)
            .Invoke(new SnapshotWriter(), null);
    }

    private static void Check(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
    }

    public static int Main()
    {
        EmporiumEntry.Instance = new EmporiumEntry { invElement = new GameInventory(), backInvinvElement = new GameInventory(),
            frontInvinvElement = new GameInventory(), afterhourPocketSlotInvLeft = new GameInventory() };
        NewGameData.Instance = new NewGameData();
        PlayerStore.instance = new PlayerStore { playerCash = 7654, saveSlotId = 3, runID = "run-3" };
        PlayerStore.HasInstance = false;
        Check(!Capture().ready && PlayerStore.accesses == 0, "Must not create a lazy PlayerStore");
        PlayerStore.HasInstance = true;
        NewGameData.Instance.isInMainMenu = true;
        Check(!Capture().ready && PlayerStore.accesses == 0, "Main menu must be unavailable");
        NewGameData.Instance.isInMainMenu = false;
        var contents = new GameInventory();
        var bag = new GameItem { identifier = "bag", name = "Bag", child = contents };
        contents.children.Add(new GameItem { identifier = "ammo", name = "Ammo", unitCount = 5 });
        contents.children.Add(new GameItem { identifier = "ammo", name = "Ammo", unitCount = 3 });
        contents.children.Add(bag);
        EmporiumEntry.Instance.invElement.children.Add(bag);
        EmporiumEntry.Instance.showcaseElement = EmporiumEntry.Instance.invElement;
        EmporiumEntry.Instance.frontInvinvElement.children.Add(new GameItem { identifier = "offer", name = "Customer offer", owned = false });
        EmporiumEntry.Instance.afterhourPocketSlotInvLeft.children.Add(new GameItem { identifier = "tool", name = "Tool" });
        var snapshot = Capture();
        Check(snapshot.ready && snapshot.cash == 7654 && snapshot.saveSlot == 3 && snapshot.runId == "run-3", "Cash/save identity must match live state");
        Check(snapshot.items.Count == 4, "Owned items (nested contents and pockets counted once) plus the visitor's counter offer");
        Check(snapshot.items.Find(item => item.id == "offer").role == "client_offer", "A visitor offer on the counter is marked, not owned");
        Check(snapshot.items.Find(item => item.id == "ammo").quantity == 8, "Stack quantities must be aggregated");
        Check(snapshot.items.Find(item => item.id == "tool").location == "pocket-left", "Pocket location must be preserved");
        Check(PlayerStore.instance.playerCash == 7654 && contents.children.Count == 3, "Reading must not mutate cash or inventory");
        ReaderJournal.enabled = true;
        ItemBoughtObserver.Postfix(new GameItem { identifier = "fanta", name = "Fanta" }, 500, null);
        AugShotObserver.Postfix();
        RentPaidObserver.Postfix(1200);
        var journalSnapshot = Capture();
        Check(journalSnapshot.events.Count == 3, "Only actual completed accounting callbacks create journal events");
        Check(journalSnapshot.events[0].itemId == "fanta" && journalSnapshot.events[1].type == "kill:ai_controlled", "Event identity must preserve observed item/kill provenance");
        Check(journalSnapshot.events[1].id != journalSnapshot.events[2].id, "Each game event must have a unique stable ID");
        DialogueJournal.enabled = true;
        PlayerStore.instance.currentClientInstance = new StoreClientInstance { client = new StoreClient { identifier = "fence_01", displayName = "老张" } };
        DialogueHistoryObserver.Postfix("<color=#eb4034>老张:</color> 这块表  <b>可是</b>真货，治安部查不到。");
        DialogueHistoryObserver.Postfix("<color=#6ecf5f>Player:</color> 三百，不能再多了。");
        DialogueHistoryObserver.Postfix("---");
        DialogueHistoryObserver.Postfix("<i>Recorder from mod</i>");
        PhoneDialogueHistoryObserver.Postfix("<color=#eb4034>Customer :</color> 货到了吗？");
        DialogueHistoryObserver.Postfix("<color=#eb4034>老张:</color> " + new String('长', 400));
        var talk = Capture();
        Check(talk.dialogue.Count == 4, "Separators and notices are not dialogue lines");
        Check(talk.dialogue[0].role == "npc" && talk.dialogue[0].speaker == "老张" && talk.dialogue[0].text == "这块表 可是真货，治安部查不到。"
            && talk.dialogue[0].clientId == "fence_01" && talk.dialogue[0].channel == "counter", "NPC lines keep speaker, clean text and client");
        Check(talk.dialogue[1].role == "player" && talk.dialogue[1].speaker == "player" && talk.dialogue[1].clientId == null, "Player lines are marked as the player");
        Check(talk.dialogue[2].speaker == "unknown" && talk.dialogue[2].channel == "phone" && talk.dialogue[2].clientId == null, "A missing name stays unknown, never guessed");
        Check(talk.dialogue[3].text.Length == DialogueJournal.MAX_TEXT, "Long lines are capped");
        Check(talk.dialogueSequence == 4 && talk.dialogue[3].id == talk.dialogueSession + ":4", "Dialogue ids are sequential within the session");
        Check(talk.events.Count == 3, "Dialogue never enters the accounting journal");
        for (var index = 0; index < DialogueJournal.MAX_LINES + 5; index++) DialogueHistoryObserver.Postfix("<color=#eb4034>老张:</color> 第" + index + "句");
        Check(Capture().dialogue.Count == DialogueJournal.MAX_LINES, "The dialogue journal is bounded");
        var buyer = new StoreClient { identifier = "fence_01", displayName = "老张" };
        ItemSoldObserver.Postfix(new GameItem { identifier = "watch", name = "手表" }, 900, 300, buyer);
        ItemSoldObserver.Postfix(new GameItem { identifier = "gift", name = "礼物" }, 400, 0, null);
        ItemSoldObserver.Postfix(new GameItem { identifier = "free", name = "白送" }, 0, 0, buyer);
        ItemSoldObserver.Postfix(new GameItem { identifier = "permit", name = "许可" }, 500, 0, new StoreClient { identifier = "businessPermitOfficial" });
        ItemBoughtObserver.Postfix(new GameItem { identifier = "lamp", name = "台灯" }, 120, buyer);
        ItemBoughtObserver.Postfix(new GameItem { identifier = "zero", name = "零元" }, 0, buyer);
        ServicePaidObserver.Postfix("appraisal", 80);
        PermitBribeObserver.Postfix(200);
        LoanTakenObserver.Postfix(0);
        var money = Capture().events;
        Check(money.Count == 8, "Sales, purchases and money moves are journaled; zero amounts and the permit official are not");
        var sold = money[3];
        Check(sold.type == "item_sold" && sold.itemId == "watch" && sold.amount == 900 && sold.boughtFor == 300
            && sold.clientId == "fence_01" && sold.clientName == "老张", "A sale keeps price, cost basis and buyer");
        Check(money[4].type == "item_sold" && money[4].boughtFor == null && money[4].clientId == null, "An unknown cost basis stays unknown");
        Check(money[5].type == "item_bought" && money[5].clientName == "老张", "A purchase keeps the seller");
        Check(money[6].type == "money:service" && money[6].detail == "appraisal" && money[6].amount == 80, "A service keeps its id");
        Check(money[7].type == "money:bribe" && money[7].amount == 200, "A bribe is journaled");
        DialogueJournal.enabled = false;
        DialogueHistoryObserver.Postfix("<color=#eb4034>老张:</color> 关闭后不记录");
        Check(Capture().dialogueSequence == 4 + DialogueJournal.MAX_LINES + 5, "A disabled reader records nothing");
        DialogueJournal.enabled = true;
        // Counters and appraisal: visitor items are visible only on the counters, with label vs actual.
        PlayerStore.HasInstance = true;
        EmporiumEntry.Instance.frontInvinvElement.children.Clear();
        EmporiumEntry.Instance.backInvinvElement.children.Clear();
        Func<string, string, int, ItemCondition> cond = (id, display, mod) => new ItemCondition { identifier = id, display = display, modValue = mod };
        var fakeWater = new GameItem { identifier = "water_bottle", name = "水瓶", owned = false, liquid = true, waterPurity = 9612 };
        fakeWater.itemFeatures.Add(new ItemFeature { category = "CATEGORY_WATER_PURITY",
            fakeCondition = cond("pure", "<color=#fff>纯净水</color>", 100), realCondition = cond("ghost", "鬼水", -40) });
        fakeWater.itemFeatures.Add(new ItemFeature { category = "CATEGORY_FRESHNESS", featureType = ItemFeature.FeatureType.Temporary,
            fakeCondition = cond("a", "a", 0), realCondition = cond("b", "b", 0) });
        EmporiumEntry.Instance.frontInvinvElement.children.Add(fakeWater);
        var emptyBottle = new GameItem { identifier = "water_bottle", name = "空瓶", owned = false, liquid = true };
        emptyBottle.itemFeatures.Add(new ItemFeature { category = "CATEGORY_WATER_PURITY", fakeCondition = cond("pure", "纯净水", 100), realCondition = cond("base", "基础水", 0) });
        EmporiumEntry.Instance.frontInvinvElement.children.Add(emptyBottle);
        var cigarettes = new GameItem { identifier = "cigarette_pack", name = "香烟" };
        cigarettes.itemFeatures.Add(new ItemFeature { category = "CATEGORY_GENUINE_CIGARETTE", fakeCondition = cond("genuine", "正品", 50), realCondition = cond("fake", "仿冒", -60) });
        EmporiumEntry.Instance.backInvinvElement.children.Add(cigarettes);
        EmporiumEntry.Instance.backInvinvElement.children.Add(new GameItem { identifier = "haggled", name = "对方的货", owned = false });
        var counters = Capture();
        var water = counters.items.Find(item => item.id == "water_bottle" && item.name == "水瓶");
        Check(water != null && water.location == "outer-counter" && water.owner == "client" && water.role == "client_offer", "A visitor item on the outer counter is the visitor's offer");
        Check(water.features.Count == 1 && water.features[0].label == "纯净水" && water.features[0].actual == "鬼水"
            && !water.features[0].match && water.features[0].overstated && water.features[0].purity == 96.12, "Water keeps label, actual, exact purity; temporary features are skipped");
        Check(counters.items.Find(item => item.name == "空瓶").features == null, "An empty bottle has no water grade");
        var cig = counters.items.Find(item => item.id == "cigarette_pack");
        Check(cig.location == "inner-counter" && cig.role == "player_offer" && cig.features[0].overstated, "The player's item on the inner counter is up for sale, with its fake label");
        Check(counters.items.Find(item => item.id == "haggled").role == "client_offer", "A visitor item on the inner counter is still the visitor's");
        Check(counters.items.Find(item => item.id == "offer") == null, "Removed counter items disappear");
        ItemSoldObserver.Postfix(cigarettes, 300, 100, buyer);
        var fakeSale = Capture().events.FindLast(item => item.type == "item_sold");
        Check(fakeSale.features != null && fakeSale.features[0].overstated && fakeSale.features[0].actual == "仿冒", "A sale records the label vs actual of what was sold");
        Console.WriteLine("PASS: collector ownership, nesting, quantities, cycles, pockets, readiness, and read-only behavior, dialogue journal, sales and money moves");
        return 0;
    }
}
