using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using Newtonsoft.Json;
using UnityEngine;
using HarmonyLib;

namespace JingjingWorldBridge
{
    public sealed class BridgeMod : IMod
    {
        private GameObject bridgeObject;

        public void Init(ModManifest manifest) { }

        public void OnEnable()
        {
            ReaderJournal.enabled = true;
            ReaderJournal.Restart();
            DialogueJournal.enabled = true;
            DialogueJournal.Restart();
            if (bridgeObject != null) return;
            bridgeObject = new GameObject("JingjingWorldBridge");
            UnityEngine.Object.DontDestroyOnLoad(bridgeObject);
            bridgeObject.AddComponent<SnapshotWriter>();
        }

        public void OnDisable()
        {
            ReaderJournal.enabled = false;
            DialogueJournal.enabled = false;
            if (bridgeObject != null) UnityEngine.Object.Destroy(bridgeObject);
            bridgeObject = null;
        }
    }

    public sealed class SnapshotWriter : MonoBehaviour
    {
        private const float SAMPLE_INTERVAL_SECONDS = 2f;
        private const int MAX_ITEMS = 1000;
        private const int MAX_NODES = 20000;
        private readonly string sessionId = Guid.NewGuid().ToString("N");
        private float nextSample;
        private float nextLog;
        private string statePath;

        private void Awake()
        {
            statePath = StateLocation.Resolve();
        }

        private void Update()
        {
            if (Time.realtimeSinceStartup < nextSample) return;
            nextSample = Time.realtimeSinceStartup + SAMPLE_INTERVAL_SECONDS;
            try
            {
                WriteSnapshot(Capture());
            }
            catch (Exception error)
            {
                // A failed read must invalidate old truth instead of publishing partial inventory.
                try { WriteSnapshot(NewSnapshot()); } catch { }
                if (Time.realtimeSinceStartup >= nextLog)
                {
                    nextLog = Time.realtimeSinceStartup + 30f;
                    UnityEngine.Debug.LogWarning("[JingjingWorldBridge] Snapshot unavailable: " + error.Message);
                }
            }
        }

        private Snapshot NewSnapshot()
        {
            return new Snapshot { sessionId = sessionId,
                capturedAt = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds };
        }

        private Snapshot Capture()
        {
            var snapshot = NewSnapshot();
            var entry = EmporiumEntry.Instance;
            var game = NewGameData.Instance;
            // HasInstance avoids the side effect in PlayerStore.Instance's lazy getter.
            if (!PlayerStore.HasInstance || entry == null || game == null || game.isInMainMenu
                || game.isShowcase || entry.invElement == null || entry.backInvinvElement == null) return snapshot;
            var store = PlayerStore.Instance;
            ReaderJournal.Bind(store);
            snapshot.sessionId = ReaderJournal.sessionId;
            var items = new Dictionary<string, ItemSnapshot>();
            var visited = new HashSet<GraphNodeStorage>();
            Collect(entry.invElement, "store", visited, items);
            // Outer counter: where visitors put what they offer. Inner counter: the negotiation table
            // (backInvinvElement), which holds the player's goods up for sale and visitor items being haggled over.
            Collect(entry.frontInvinvElement, Locations.OUTER_COUNTER, visited, items);
            Collect(entry.backInvinvElement, Locations.INNER_COUNTER, visited, items);
            Collect(entry.backInvinvElementCounter, "counter-stash", visited, items);
            Collect(entry.showcaseElement, "showcase", visited, items);
            Collect(entry.hiddenElement, "hidden", visited, items);
            Collect(entry.docInvElement, "documents", visited, items);
            Collect(entry.cassettePlayerElement, "cassette-player", visited, items);
            Collect(entry.vendingMachineElement, "vending-machine", visited, items);
            Collect(entry.vendingFountainElement, "vending-fountain", visited, items);
            Collect(entry.hirelingInv, "hireling", visited, items);
            Collect(entry.afterhourPocketSlotInvLeft, "pocket-left", visited, items);
            Collect(entry.afterhourPocketSlotInvBackpack, "pocket-backpack", visited, items);
            Collect(entry.afterhourPocketSlotInvRight, "pocket-right", visited, items);
            snapshot.cash = store.playerCash;
            snapshot.location = store.playerLocation.ToString();
            snapshot.rent = store.rentValue;
            snapshot.day = StoreStation.Instance == null ? (int?)null : StoreStation.Instance.dayCounter;
            if (store.secData != null)
            {
                snapshot.investigation = store.secData.evidenceLevel;
                snapshot.crime = store.secData.GetTotalCrimeValue();
            }
            if (store.runStats != null)
            {
                snapshot.rentPaid = store.runStats.rentPaid;
                snapshot.augsShot = store.runStats.augsShot;
            }
            if (store.storeReputations != null) foreach (var reputation in store.storeReputations)
            {
                if (reputation != null && !String.IsNullOrEmpty(reputation.factionId))
                    snapshot.reputation[reputation.factionId] = reputation.GetReputationExact();
            }
            var client = store.isClientArrived && store.currentClientInstance != null
                ? store.currentClientInstance.GetClientBlueprint() : null;
            if (client != null)
            {
                snapshot.client = new ClientSnapshot { id = client.identifier, name = client.displayName,
                    faction = client.clientFaction, isSecurity = client.isSecurity,
                    visit = ClientVisits.Observe(store, store.currentClientInstance) };
            }
            // Optional context: each part fails alone, so a game update can never blank the inventory.
            snapshot.scene = WorldReader.Scene(store);
            snapshot.health = WorldReader.Health(store);
            snapshot.difficulty = WorldReader.ReadDifficulty(store);
            snapshot.scavLeft = WorldReader.ScavLeft();
            snapshot.events.AddRange(ReaderJournal.events);
            snapshot.eventSequence = ReaderJournal.lastSequence;
            DialogueJournal.Bind(store);
            snapshot.dialogueSession = DialogueJournal.sessionId;
            snapshot.dialogue.AddRange(DialogueJournal.lines);
            snapshot.dialogueSequence = DialogueJournal.lastSequence;
            snapshot.saveSlot = store.saveSlotId;
            snapshot.runId = String.IsNullOrEmpty(store.runID) ? "slot-" + store.saveSlotId : store.runID;
            snapshot.items.AddRange(items.Values);
            snapshot.items.Sort((left, right) => StringComparer.Ordinal.Compare(left.location + ":" + left.id, right.location + ":" + right.id));
            snapshot.ready = true;
            return snapshot;
        }

        private static void Collect(GraphNodeStorage root, string location, HashSet<GraphNodeStorage> visited,
            Dictionary<string, ItemSnapshot> items)
        {
            if (root == null || !visited.Add(root)) return;
            if (visited.Count > MAX_NODES) throw new InvalidOperationException("Inventory graph exceeds limit");
            var item = root as GameItem;
            if (item != null)
            {
                var owned = GeneralHelper.IsItemOwned(item);
                // Visitor items are only visible on the counters; anywhere else they are not the player's business.
                if (!owned && !Locations.IsCounter(location)) return;
                var id = String.IsNullOrEmpty(item.identifier) ? "unknown" : item.identifier;
                var name = item.GetDisplayName(true);
                var features = Appraisal.Read(item);
                var key = location + "\n" + id + "\n" + name + "\n" + owned + "\n" + Appraisal.Signature(features);
                ItemSnapshot record;
                if (!items.TryGetValue(key, out record))
                {
                    if (items.Count >= MAX_ITEMS) throw new InvalidOperationException("Inventory exceeds limit");
                    record = new ItemSnapshot { id = id, name = name, location = location,
                        owner = owned ? "player" : "client", role = Locations.Role(location, owned),
                        features = features.Count == 0 ? null : features };
                    items.Add(key, record);
                }
                record.quantity = checked(record.quantity + Math.Max(0, item.unitCount));
                // Only traverse actual contents, excluding the inspection UI graph.
                Collect(item.child, location, visited, items);
                return;
            }
            var children = root.children;
            if (children == null) return;
            foreach (var child in children) Collect(child, location, visited, items);
        }

        private void WriteSnapshot(Snapshot snapshot)
        {
            var temporaryPath = statePath + ".tmp";
            File.WriteAllText(temporaryPath, JsonConvert.SerializeObject(snapshot));
            if (File.Exists(statePath)) File.Replace(temporaryPath, statePath, null);
            else File.Move(temporaryPath, statePath);
        }

        private void OnDestroy()
        {
            try { WriteSnapshot(NewSnapshot()); } catch { }
        }
    }

    // Snapshot location independent of where the mod is installed: a Workshop item lives under
    // steamapps/workshop/content, so the game Mods folder may not contain this mod at all.
    public static class StateLocation
    {
        public const string FOLDER = "CharacterCompanion";
        public const string GAME = "probably-stolen";

        public static string Resolve()
        {
            var baseDir = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (string.IsNullOrEmpty(baseDir)) baseDir = Path.Combine(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "AppData"), "Local");
            var directory = Path.Combine(Path.Combine(baseDir, FOLDER), GAME);
            System.IO.Directory.CreateDirectory(directory);
            return Path.Combine(directory, "state.json");
        }
    }

    public sealed class Snapshot
    {
        public int schemaVersion = 1;
        public string source = "probably-stolen";
        public string sessionId;
        public long capturedAt;
        public bool ready;
        public int saveSlot;
        public string runId;
        public int cash;
        public int? investigation;
        public int? crime;
        public int? rent;
        public int? day;
        public int? rentPaid;
        public int? augsShot;
        public string location;
        // Where the player actually is ("store", "map", "end_of_day" or an after-hours location id); null if unreadable.
        public SceneSnapshot scene;
        public HealthSnapshot health;
        public DifficultySnapshot difficulty;
        // Dumping ground searches left tonight.
        public int? scavLeft;
        public ClientSnapshot client;
        public Dictionary<string, double> reputation = new Dictionary<string, double>();
        public List<ReaderEvent> events = new List<ReaderEvent>();
        public int eventSequence;
        // Completed dialogue lines; a separate journal so chatter never pushes accounting events out of theirs.
        public string dialogueSession;
        public List<DialogueLine> dialogue = new List<DialogueLine>();
        public int dialogueSequence;
        public List<ItemSnapshot> items = new List<ItemSnapshot>();
    }

    public sealed class ClientSnapshot
    {
        public string id, name, faction;
        public bool isSecurity;
        // Increments whenever a different visitor instance stands at the counter (same blueprint twice = two visits).
        public int visit;
    }

    public sealed class SceneSnapshot
    {
        public string id, title;
        // After-hours locations only: the game's own visit count and the day of the last visit.
        public int? visits, lastVisitDay;
    }

    public sealed class HealthSnapshot
    {
        // 0 healthy, 1-5 minor, above 5 serious (the game's own threshold).
        public int wound;
        public bool stable, fresh, serious;
    }

    public sealed class DifficultySnapshot
    {
        public string id, title;
        // Selling markup actually applied by this store, and the rule values she may quote.
        public int retailMarkup, inventorMarkup, retiredSupplierMarkup, merchantDiscount;
        // The game's own localized rule lines, e.g. "Retail markup of 15% when selling".
        public List<string> effects;
    }

    public sealed class LootSnapshot
    {
        public string id, name;
        public int quantity;
        // Current value of one unit (no retail markup); null when the game could not price it.
        public long? value;
    }

    public sealed class ReaderEvent
    {
        public string id, type, itemId, itemName, runId;
        public int amount;
        public long at;
        // Sales: what the item was bought for (null when the game does not know). Trades and services: who / what.
        public int? boughtFor;
        public string clientId, clientName, detail;
        // Label vs actual of the traded item at the moment of the trade (null when it has none).
        public List<FeatureSnapshot> features;
        // Bargains: "accepted" / "refused" / "worked" / "failed" / "innocent" (blackmailing someone with nothing to hide).
        public string outcome;
        // Scavenging: what was found.
        public List<LootSnapshot> loot;
        // Night report lines, plain text.
        public List<string> lines;
    }

    public static class ReaderJournal
    {
        public static bool enabled;
        public static string sessionId = Guid.NewGuid().ToString("N");
        public static readonly List<ReaderEvent> events = new List<ReaderEvent>();
        private static PlayerStore boundStore;
        private static int sequence;
        public static int lastSequence { get { return sequence; } }

        public static void Restart() { boundStore = null; }

        public static void Bind(PlayerStore store)
        {
            if (System.Object.ReferenceEquals(boundStore, store)) return;
            boundStore = store;
            sessionId = Guid.NewGuid().ToString("N");
            sequence = 0;
            events.Clear();
        }

        public static void Record(string type, GameItem item, int amount)
        {
            Record(type, item, amount, null, null, null);
        }

        public static void Record(string type, GameItem item, int amount, int? boughtFor, StoreClient client, string detail)
        {
            Add(new ReaderEvent { type = type, amount = amount,
                itemId = item == null ? null : item.identifier, itemName = item == null ? null : item.GetDisplayName(true),
                boughtFor = boughtFor, clientId = client == null ? null : client.identifier,
                clientName = client == null ? null : client.displayName, detail = detail,
                features = item == null ? null : Appraisal.ReadOrNull(item) });
        }

        // Stamps identity, run and time; the caller fills in what happened.
        public static void Add(ReaderEvent entry)
        {
            if (!enabled || !PlayerStore.HasInstance) return;
            var store = PlayerStore.Instance;
            Bind(store);
            entry.id = sessionId + ":" + (++sequence);
            entry.runId = store.saveSlotId + ":" + (String.IsNullOrEmpty(store.runID) ? "slot-" + store.saveSlotId : store.runID);
            entry.at = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;
            events.Add(entry);
            if (events.Count > 128) events.RemoveAt(0);
        }

        // Accounting callbacks run inside the game's own flow: a reader failure must never break it.
        public static void SafeRecord(string type, GameItem item, int amount, int? boughtFor, StoreClient client, string detail)
        {
            try { Record(type, item, amount, boughtFor, client, detail); } catch { }
        }

        public static void SafeAdd(Func<ReaderEvent> build)
        {
            try { var entry = build(); if (entry != null) Add(entry); } catch { }
        }
    }

    public sealed class DialogueLine
    {
        // clientName: display name of the visitor at the counter when the line was written (counter NPC lines only).
        // scene: where the player was, so a shopkeeper at a night location is not taken for a visitor.
        public string id, role, channel, speaker, text, runId, clientId, clientName, scene;
        public int seq;
        // Visit number of that visitor (see ClientVisits); null when no visitor was at the counter.
        public int? visit;
        public bool security;
        public long at;
    }

    // Each finished line the game writes to its dialogue history (the full text, never the typewriter's partial text).
    public static class DialogueJournal
    {
        public const int MAX_LINES = 40;
        public const int MAX_TEXT = 180;
        private const string PLAYER_COLOR = "<color=#6ecf5f>";
        private const string NPC_COLOR = "<color=#eb4034>";
        public static bool enabled;
        public static string sessionId = Guid.NewGuid().ToString("N");
        public static readonly List<DialogueLine> lines = new List<DialogueLine>();
        private static PlayerStore boundStore;
        private static int sequence;
        public static int lastSequence { get { return sequence; } }

        public static void Restart() { boundStore = null; }

        public static void Bind(PlayerStore store)
        {
            if (System.Object.ReferenceEquals(boundStore, store)) return;
            boundStore = store;
            sessionId = Guid.NewGuid().ToString("N");
            sequence = 0;
            lines.Clear();
        }

        // "<color=#eb4034>Name:</color> text" -> role, speaker, text. Separators and notices return null.
        public static DialogueLine Parse(string entry)
        {
            if (String.IsNullOrEmpty(entry)) return null;
            string role = entry.StartsWith(PLAYER_COLOR, StringComparison.Ordinal) ? "player"
                : entry.StartsWith(NPC_COLOR, StringComparison.Ordinal) ? "npc" : null;
            if (role == null) return null;
            var plain = Regex.Replace(entry, "<[^>]*>", "");
            var colon = plain.IndexOf(':');
            if (colon <= 0) return null;
            var speaker = plain.Substring(0, colon).Trim();
            var text = Regex.Replace(plain.Substring(colon + 1), @"\s+", " ").Trim();
            if (text.Length == 0) return null;
            if (text.Length > MAX_TEXT) text = text.Substring(0, MAX_TEXT);
            // The game writes "Customer" when it has no client name; never guess one.
            if (role == "npc" && (speaker.Length == 0 || speaker == "Customer")) speaker = "unknown";
            if (role == "player") speaker = "player";
            return new DialogueLine { role = role, speaker = speaker, text = text };
        }

        public static void Record(string entry, string channel)
        {
            if (!enabled || !PlayerStore.HasInstance) return;
            var line = Parse(entry);
            if (line == null) return;
            var store = PlayerStore.Instance;
            Bind(store);
            line.channel = channel;
            line.seq = ++sequence;
            line.id = sessionId + ":" + line.seq;
            line.runId = store.saveSlotId + ":" + (String.IsNullOrEmpty(store.runID) ? "slot-" + store.saveSlotId : store.runID);
            var instance = line.role == "npc" && channel == "counter" ? store.currentClientInstance : null;
            var client = instance != null ? instance.GetClientBlueprint() : null;
            line.clientId = client == null ? null : client.identifier;
            line.clientName = client == null ? null : client.displayName;
            line.security = client != null && client.isSecurity;
            line.visit = client == null ? (int?)null : ClientVisits.Observe(store, instance);
            line.scene = WorldReader.SceneId();
            line.at = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;
            lines.Add(line);
            if (lines.Count > MAX_LINES) lines.RemoveAt(0);
        }

        // A reader failure must never break the game's dialogue flow.
        public static void SafeRecord(string entry, string channel)
        {
            try { Record(entry, channel); } catch { }
        }
    }

    [HarmonyPatch(typeof(DialogUIManager), "UpdateDialogHistory")]
    public static class DialogueHistoryObserver
    {
        [HarmonyPostfix]
        public static void Postfix(string __0) { DialogueJournal.SafeRecord(__0, "counter"); }
    }

    [HarmonyPatch(typeof(DialoguePhoneUIManager), "UpdateDialogHistory")]
    public static class PhoneDialogueHistoryObserver
    {
        [HarmonyPostfix]
        public static void Postfix(string __0) { DialogueJournal.SafeRecord(__0, "phone"); }
    }

    // Observe completed game accounting callbacks; never replace results or skip originals.
    [HarmonyPatch(typeof(RunStats), "OnItemBought")]
    public static class ItemBoughtObserver
    {
        [HarmonyPostfix]
        public static void Postfix(GameItem __0, int __1, StoreClient __2)
        {
            // Same guard as the game: only real purchases count.
            if (__0 == null || __1 <= 0) return;
            ReaderJournal.SafeRecord("item_bought", __0, __1, null, __2, null);
        }
    }

    [HarmonyPatch(typeof(RunStats), "OnItemSold")]
    public static class ItemSoldObserver
    {
        [HarmonyPostfix]
        public static void Postfix(GameItem __0, int __1, int __2, StoreClient __3)
        {
            // Same guard as the game: no zero-price handovers, and the permit official is not a sale.
            if (__0 == null || __1 <= 0 || (__3 != null && __3.identifier == "businessPermitOfficial")) return;
            ReaderJournal.SafeRecord("item_sold", __0, __1, __2 > 0 ? (int?)__2 : null, __3, null);
        }
    }

    // Money that moves without a traded item, so a balance change can name its reason.
    [HarmonyPatch(typeof(RunStats), "OnServicePaid")]
    public static class ServicePaidObserver
    {
        [HarmonyPostfix]
        public static void Postfix(string __0, int __1) { if (__1 > 0) ReaderJournal.SafeRecord("money:service", null, __1, null, null, __0); }
    }

    [HarmonyPatch(typeof(RunStats), "OnPermitBribe")]
    public static class PermitBribeObserver
    {
        [HarmonyPostfix]
        public static void Postfix(int __0) { if (__0 > 0) ReaderJournal.SafeRecord("money:bribe", null, __0, null, null, null); }
    }

    [HarmonyPatch(typeof(RunStats), "OnPermitBought")]
    public static class PermitBoughtObserver
    {
        [HarmonyPostfix]
        public static void Postfix(int __0) { if (__0 > 0) ReaderJournal.SafeRecord("money:permit", null, __0, null, null, null); }
    }

    [HarmonyPatch(typeof(RunStats), "OnVendingSale")]
    public static class VendingSaleObserver
    {
        [HarmonyPostfix]
        public static void Postfix(int __0) { if (__0 > 0) ReaderJournal.SafeRecord("money:vending", null, __0, null, null, null); }
    }

    [HarmonyPatch(typeof(RunStats), "OnFountainSale")]
    public static class FountainSaleObserver
    {
        [HarmonyPostfix]
        public static void Postfix(int __0) { if (__0 > 0) ReaderJournal.SafeRecord("money:fountain", null, __0, null, null, null); }
    }

    [HarmonyPatch(typeof(RunStats), "OnMortgagePayment")]
    public static class MortgagePaymentObserver
    {
        [HarmonyPostfix]
        public static void Postfix(int __0) { if (__0 > 0) ReaderJournal.SafeRecord("money:mortgage", null, __0, null, null, null); }
    }

    [HarmonyPatch(typeof(RunStats), "OnGeorgioLoan")]
    public static class LoanTakenObserver
    {
        [HarmonyPostfix]
        public static void Postfix(int __0) { if (__0 > 0) ReaderJournal.SafeRecord("money:loan_taken", null, __0, null, null, null); }
    }

    [HarmonyPatch(typeof(RunStats), "OnGeorgioPayback")]
    public static class LoanRepaidObserver
    {
        [HarmonyPostfix]
        public static void Postfix(int __0) { if (__0 > 0) ReaderJournal.SafeRecord("money:loan_repaid", null, __0, null, null, null); }
    }

    [HarmonyPatch(typeof(RunStats), "OnRentPaid")]
    public static class RentPaidObserver
    {
        [HarmonyPostfix]
        public static void Postfix(int __0) { ReaderJournal.Record("rent_paid", null, __0); }
    }

    [HarmonyPatch(typeof(RunStats), "OnAugShot")]
    public static class AugShotObserver
    {
        [HarmonyPostfix]
        public static void Postfix() { ReaderJournal.Record("kill:ai_controlled", null, 1); }
    }

    // Counts visitor instances, so lines and trades of two people in a row never blur into one.
    public static class ClientVisits
    {
        private static PlayerStore boundStore;
        private static object lastInstance;
        private static int visit;

        public static int Observe(PlayerStore store, object instance)
        {
            if (!System.Object.ReferenceEquals(boundStore, store)) { boundStore = store; lastInstance = null; visit = 0; }
            if (instance != null && !System.Object.ReferenceEquals(lastInstance, instance)) { lastInstance = instance; visit++; }
            return visit;
        }
    }

    // Read-only context: where the player is, how hurt, which difficulty. Each reader returns null on failure.
    public static class WorldReader
    {
        public const string STORE = "store";
        public const string MAP = "map";
        public const string END_OF_DAY = "end_of_day";
        private const int MAX_TEXT = 120;
        private const int MAX_EFFECTS = 12;
        private static string difficultyKey;
        private static List<string> difficultyEffects;

        public static string SceneId()
        {
            try
            {
                var map = MapUIManager.Instance;
                if (map != null && map.Current != null) return map.Current.Id;
                if (TransitUI.IsOpen) return MAP;
                var endOfDay = EndOfDayUIManager.Instance;
                if (endOfDay != null && endOfDay.IsOpen) return END_OF_DAY;
                return STORE;
            }
            catch { return null; }
        }

        public static SceneSnapshot Scene(PlayerStore store)
        {
            try
            {
                var id = SceneId();
                if (id == null) return null;
                var scene = new SceneSnapshot { id = id };
                var map = MapUIManager.Instance;
                var location = map == null ? null : map.Current;
                if (location != null)
                {
                    scene.title = Plain(location.GetTitle(), 48);
                    // Travel() has already created and counted this location's state; reading it adds nothing new.
                    var state = store.GetAfterhourState(location.Id);
                    scene.visits = state.visits;
                    scene.lastVisitDay = state.lastVisitDay;
                }
                return scene;
            }
            catch { return null; }
        }

        public static HealthSnapshot Health(PlayerStore store)
        {
            try
            {
                var health = store.healthData;
                if (health == null) return null;
                return new HealthSnapshot { wound = health.woundState, stable = health.isWoundStable, fresh = health.isWoundedFresh,
                    serious = health.woundState > HealthData.SERIOUS_WOUND_THRESHOLD };
            }
            catch { return null; }
        }

        public static DifficultySnapshot ReadDifficulty(PlayerStore store)
        {
            try
            {
                var current = Difficulty.Current;
                if (current == null || current.rules == null) return null;
                var rules = current.rules;
                // Localized lines are built once per difficulty and markup, not every two seconds.
                var key = current.id + "|" + store.retailMarkup + "|" + rules.retailMarkup;
                if (key != difficultyKey)
                {
                    var effects = new List<string>();
                    foreach (var line in Difficulty.GetEffectLines(current))
                    {
                        var text = Plain(line, MAX_TEXT);
                        if (text != null && effects.Count < MAX_EFFECTS) effects.Add(text);
                    }
                    difficultyEffects = effects;
                    difficultyKey = key;
                }
                return new DifficultySnapshot { id = current.id, title = Plain(current.GetTitle(), 48), retailMarkup = store.retailMarkup,
                    inventorMarkup = rules.inventorMarkup, retiredSupplierMarkup = rules.retiredSupplierMarkup,
                    merchantDiscount = rules.merchantDiscount, effects = new List<string>(difficultyEffects) };
            }
            catch { return null; }
        }

        public static int? ScavLeft()
        {
            try { return ScavHelper.GetScavTimeLeft(); } catch { return null; }
        }

        public static string Plain(string text, int max)
        {
            if (String.IsNullOrEmpty(text)) return null;
            var plain = Regex.Replace(Regex.Replace(text, "<[^>]*>", ""), @"\s+", " ").Trim();
            if (plain.Length == 0) return null;
            return plain.Length > max ? plain.Substring(0, max) : plain;
        }
    }

    // Scavenging at the dumping ground: what was found and who got hurt. Observes only.
    [HarmonyPatch(typeof(RunStats), "OnScavengedItems")]
    public static class ScavengedItemsObserver
    {
        public const int MAX_LOOT = 12;

        [HarmonyPostfix]
        public static void Postfix(List<GameItem> __0)
        {
            ReaderJournal.SafeAdd(delegate
            {
                if (__0 == null || __0.Count == 0) return null;
                var loot = new List<LootSnapshot>();
                foreach (var item in __0)
                {
                    if (item == null || loot.Count >= MAX_LOOT) continue;
                    long? value = null;
                    try { value = item.GetCurrentValue(); } catch { }
                    loot.Add(new LootSnapshot { id = String.IsNullOrEmpty(item.identifier) ? "unknown" : item.identifier,
                        name = WorldReader.Plain(item.GetDisplayName(true), 48) ?? "unknown", quantity = Math.Max(1, item.unitCount), value = value });
                }
                return loot.Count == 0 ? null : new ReaderEvent { type = "scav_loot", amount = loot.Count, loot = loot };
            });
        }
    }

    [HarmonyPatch(typeof(RunStats), "OnScavengeInjury")]
    public static class ScavengeInjuryObserver
    {
        [HarmonyPostfix]
        public static void Postfix(bool __0)
        {
            ReaderJournal.SafeAdd(delegate { return new ReaderEvent { type = "scav_injury", amount = 1, detail = __0 ? "major" : "minor" }; });
        }
    }

    // The night report shown each morning; read just before the game clears it.
    [HarmonyPatch(typeof(StartOfDayUIManager), "InitPanel")]
    public static class NightLogObserver
    {
        public const int MAX_LINES = 12;

        [HarmonyPrefix]
        public static void Prefix()
        {
            ReaderJournal.SafeAdd(delegate
            {
                if (!PlayerStore.HasInstance) return null;
                var logs = PlayerStore.Instance.nightLogs;
                if (logs == null || logs.Count == 0) return null;
                var lines = new List<string>();
                foreach (var log in logs)
                {
                    var text = WorldReader.Plain(log, 120);
                    if (text != null && lines.Count < MAX_LINES) lines.Add(text);
                }
                return lines.Count == 0 ? null : new ReaderEvent { type = "night_log", amount = lines.Count, lines = lines };
            });
        }
    }

    // One-shot bargains at the counter. The game rolls acceptance inside the call, so the postfix sees the result.
    public static class Bargains
    {
        public static void Record(string kind, bool offeredBefore, bool offeredAfter, int percent, string outcome, StoreClient client)
        {
            if (offeredBefore || !offeredAfter) return;
            ReaderJournal.SafeAdd(delegate
            {
                return new ReaderEvent { type = "bargain", detail = kind, amount = Math.Abs(percent), outcome = outcome,
                    clientId = client == null ? null : client.identifier, clientName = client == null ? null : client.displayName };
            });
        }
    }

    [HarmonyPatch(typeof(BargainUIManager), "OfferDiscount")]
    public static class DiscountObserver
    {
        [HarmonyPrefix] public static void Prefix(bool ___discountOffered, out bool __state) { __state = ___discountOffered; }
        [HarmonyPostfix] public static void Postfix(int __0, bool ___discountOffered, StoreClient ___trackedClient, bool __state)
        { Bargains.Record("discount", __state, ___discountOffered, __0, "accepted", ___trackedClient); }
    }

    [HarmonyPatch(typeof(BargainUIManager), "OfferMarkup")]
    public static class MarkupObserver
    {
        [HarmonyPrefix] public static void Prefix(bool ___markupOffered, out bool __state) { __state = ___markupOffered; }
        [HarmonyPostfix] public static void Postfix(int __0, bool ___markupOffered, bool ___markupApplied, StoreClient ___trackedClient, bool __state)
        { Bargains.Record("markup", __state, ___markupOffered, __0, ___markupApplied ? "accepted" : "refused", ___trackedClient); }
    }

    [HarmonyPatch(typeof(BargainUIManager), "OfferBuyingMarkup")]
    public static class BuyingMarkupObserver
    {
        [HarmonyPrefix] public static void Prefix(bool ___buyingMarkupOffered, out bool __state) { __state = ___buyingMarkupOffered; }
        [HarmonyPostfix] public static void Postfix(int __0, bool ___buyingMarkupOffered, StoreClient ___trackedClient, bool __state)
        { Bargains.Record("buying_markup", __state, ___buyingMarkupOffered, __0, "accepted", ___trackedClient); }
    }

    [HarmonyPatch(typeof(BargainUIManager), "DemandBuyingDiscount")]
    public static class BuyingDiscountObserver
    {
        [HarmonyPrefix] public static void Prefix(bool ___buyingDiscountOffered, out bool __state) { __state = ___buyingDiscountOffered; }
        [HarmonyPostfix] public static void Postfix(int __0, bool ___buyingDiscountOffered, bool ___buyingDiscountApplied, StoreClient ___trackedClient, bool __state)
        { Bargains.Record("buying_discount", __state, ___buyingDiscountOffered, __0, ___buyingDiscountApplied ? "accepted" : "refused", ___trackedClient); }
    }

    [HarmonyPatch(typeof(BargainUIManager), "Blackmail")]
    public static class BlackmailObserver
    {
        [HarmonyPrefix] public static void Prefix(bool ___blackmailOffered, out bool __state) { __state = ___blackmailOffered; }
        [HarmonyPostfix] public static void Postfix(BargainUIManager __instance, bool ___blackmailOffered, bool ___blackmailApplied, StoreClient ___trackedClient, bool __state)
        {
            // A wanted visitor can still refuse (random roll); an innocent one cannot be blackmailed at all.
            var outcome = ___blackmailApplied ? "worked" : "failed";
            if (!___blackmailApplied) try { outcome = __instance.IsCriminal() ? "refused" : "innocent"; } catch { }
            Bargains.Record("blackmail", __state, ___blackmailOffered, 20, outcome, ___trackedClient);
        }
    }

    [HarmonyPatch(typeof(BargainUIManager), "ThreatenAug")]
    public static class ThreatenObserver
    {
        [HarmonyPrefix] public static void Prefix(bool ___threatenOffered, out bool __state) { __state = ___threatenOffered; }
        [HarmonyPostfix] public static void Postfix(bool ___threatenOffered, bool ___threatenApplied, StoreClient ___trackedClient, bool __state)
        { Bargains.Record("threaten", __state, ___threatenOffered, 20, ___threatenApplied ? "worked" : "failed", ___trackedClient); }
    }

    public sealed class ItemSnapshot
    {
        public string id;
        public string name;
        public string location;
        public int quantity;
        // "player" or "client" (a visitor's item on a counter).
        public string owner;
        // "client_offer": the visitor is selling it; "player_offer": the player put it on the table to sell; else null.
        public string role;
        public List<FeatureSnapshot> features;
    }

    public static class Locations
    {
        public const string OUTER_COUNTER = "outer-counter";
        public const string INNER_COUNTER = "inner-counter";

        public static bool IsCounter(string location) { return location == OUTER_COUNTER || location == INNER_COUNTER; }

        public static string Role(string location, bool owned)
        {
            if (!IsCounter(location)) return null;
            if (!owned) return "client_offer";
            return location == INNER_COUNTER ? "player_offer" : null;
        }
    }

    // One appraisable property: what the label claims versus what the item really is.
    public sealed class FeatureSnapshot
    {
        public string category;
        // Null when the item carries no public claim for this property.
        public string label;
        public string actual;
        public bool match;
        // The label claims better than the truth (a fake / overstated label), or worse (understated).
        public bool overstated;
        public bool understated;
        // The player has already exposed the truth in negotiation.
        public bool exposed;
        // Exact water purity in percent, for liquid containers.
        public double? purity;
    }

    // Reads the game's own label/actual pairs (ItemFeature fake/real conditions). Read-only.
    public static class Appraisal
    {
        private const int MAX_FEATURES = 6;
        private const int MAX_TEXT = 40;

        public static List<FeatureSnapshot> ReadOrNull(GameItem item)
        {
            try
            {
                var features = Read(item);
                return features.Count == 0 ? null : features;
            }
            catch { return null; }
        }

        public static List<FeatureSnapshot> Read(GameItem item)
        {
            var result = new List<FeatureSnapshot>();
            if (item == null || item.itemFeatures == null) return result;
            foreach (var feature in item.itemFeatures)
            {
                if (result.Count >= MAX_FEATURES) break;
                if (feature == null || feature.isDisabled || !feature.useCondition
                    || feature.realCondition == null || feature.fakeCondition == null) continue;
                if (feature.featureType != ItemFeature.FeatureType.Normale && feature.featureType != ItemFeature.FeatureType.Special) continue;
                var category = feature.GetCategory();
                var water = category == "CATEGORY_WATER_PURITY" && item.IsTag("LIQUID_CONTAINER_TAG");
                // An empty bottle still carries a water grade; it means nothing.
                if (water && WaterHelper.IsEmpty(item)) continue;
                var actual = Clean(feature.realCondition.display);
                if (actual == null) continue;
                var fake = feature.fakeCondition;
                var real = feature.realCondition;
                var match = feature.IsFeatureMatch();
                var better = fake.modValue != real.modValue ? fake.modValue > real.modValue : fake.compareValue > real.compareValue;
                var worse = fake.modValue != real.modValue ? fake.modValue < real.modValue : fake.compareValue < real.compareValue;
                var snapshot = new FeatureSnapshot { category = category,
                    label = fake.hiddenAsPublic ? null : Clean(fake.display), actual = actual, match = match,
                    overstated = !match && better, understated = !match && worse, exposed = feature.IsExposed() };
                if (water) snapshot.purity = Math.Round(WaterHelper.GetWaterPurity(item) / 100.0, 2);
                result.Add(snapshot);
            }
            return result;
        }

        public static string Signature(List<FeatureSnapshot> features)
        {
            if (features.Count == 0) return "";
            var parts = new List<string>();
            foreach (var feature in features) parts.Add(feature.category + "=" + feature.label + ">" + feature.actual + (feature.exposed ? "!" : ""));
            return String.Join("|", parts.ToArray());
        }

        private static string Clean(string text)
        {
            if (String.IsNullOrEmpty(text)) return null;
            var plain = Regex.Replace(Regex.Replace(text, "<[^>]*>", ""), @"\s+", " ").Trim();
            if (plain.Length == 0) return null;
            return plain.Length > MAX_TEXT ? plain.Substring(0, MAX_TEXT) : plain;
        }
    }
}
