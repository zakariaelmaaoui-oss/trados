//+------------------------------------------------------------------+
//| TradeOS_Sync.mq5                                                 |
//| Sends every CLOSED position of this MT5 account to TradeOS.      |
//|                                                                  |
//| Setup:                                                           |
//|  1. Tools > Options > Expert Advisors: tick "Allow WebRequest    |
//|     for listed URL" and add your TradeOS address, e.g.           |
//|     https://trados-eight.vercel.app                              |
//|  2. Drag this EA onto ANY one chart, paste your key, OK.         |
//|     Your MT5 account (broker, Demo/Live, balance) is created in  |
//|     TradeOS automatically - nothing to type on the website.      |
//|  3. Keep "Algo Trading" switched on. MT5 must stay open.         |
//|                                                                  |
//| The EA only READS history. It never opens, modifies or closes    |
//| trades.                                                          |
//+------------------------------------------------------------------+
#property copyright "TradeOS"
#property version   "1.11"
#property description "Sync closed positions to TradeOS (read-only, never trades)."

input string InpUrl         = "https://trados-eight.vercel.app"; // TradeOS address
input string InpKey         = "";                                // Sync key (tos_...)
input int    InpDaysBack    = 30;   // First sync: how many days of history
input int    InpIntervalSec = 60;   // Check every N seconds

#define BATCH_SIZE 100

datetime g_lastOkSync   = 0;     // last successful sync (server time)
bool     g_pending      = true;  // something to send
string   g_lastStatus   = "";

//+------------------------------------------------------------------+
int OnInit()
  {
   if(StringLen(InpKey) < 20 || StringSubstr(InpKey, 0, 4) != "tos_")
     {
      Alert("TradeOS: paste your sync key (starts with tos_) in the EA inputs.");
      return(INIT_PARAMETERS_INCORRECT);
     }
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) && !MQLInfoInteger(MQL_TESTER))
      Print("TradeOS: tip - switch on Algo Trading so the EA keeps running.");
   EventSetTimer(MathMax(15, InpIntervalSec));
   // OnInit also runs when you switch to another MT5 account (globals are kept),
   // so always start with a full history scan for the account now logged in.
   g_lastOkSync = 0;
   g_pending = true;
   Ping();
   SyncNow();
   return(INIT_SUCCEEDED);
  }

void OnDeinit(const int reason) { EventKillTimer(); Comment(""); }

void OnTimer() { SyncNow(); }

// A position was closed (fully or partly): sync soon.
void OnTradeTransaction(const MqlTradeTransaction &trans, const MqlTradeRequest &request, const MqlTradeResult &result)
  {
   if(trans.type == TRADE_TRANSACTION_DEAL_ADD)
      g_pending = true;
  }

//+------------------------------------------------------------------+
string BaseUrl()
  {
   string u = InpUrl;
   while(StringLen(u) > 0 && StringSubstr(u, StringLen(u) - 1, 1) == "/")
      u = StringSubstr(u, 0, StringLen(u) - 1);
   return u;
  }

string JsonEscape(string s)
  {
   StringReplace(s, "\\", "\\\\");
   StringReplace(s, "\"", "\\\"");
   return s;
  }

string Num(double v, int digits = 8) { return DoubleToString(v, digits); }

string TradeMode()
  {
   long m = AccountInfoInteger(ACCOUNT_TRADE_MODE);
   if(m == ACCOUNT_TRADE_MODE_REAL)    return "real";
   if(m == ACCOUNT_TRADE_MODE_CONTEST) return "contest";
   return "demo";
  }

// Returns HTTP status (or -1) and fills body.
int Http(string method, string path, string payload, string &body)
  {
   char data[];
   char result[];
   string resHeaders;
   string headers = "Authorization: Bearer " + InpKey + "\r\nContent-Type: application/json\r\n";
   if(payload != "")
     {
      StringToCharArray(payload, data, 0, WHOLE_ARRAY, CP_UTF8);
      ArrayResize(data, ArraySize(data) - 1); // drop the trailing \0
     }
   ResetLastError();
   int code = WebRequest(method, BaseUrl() + path, headers, 15000, data, result, resHeaders);
   body = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   if(code == -1)
     {
      int err = GetLastError();
      if(err == 4014)
         body = "WebRequest not allowed. Add " + BaseUrl() + " in Tools > Options > Expert Advisors > Allow WebRequest for listed URL.";
      else
         body = "Network error " + IntegerToString(err);
     }
   return code;
  }

void Ping()
  {
   string body;
   int code = Http("GET", "/api/mt5/ping", "", body);
   if(code == 200) g_lastStatus = "Connected to TradeOS: " + body;
   else            g_lastStatus = "TradeOS connection failed (" + IntegerToString(code) + "): " + body;
   Print(g_lastStatus);
   Comment("TradeOS Sync\n", g_lastStatus);
  }

//+------------------------------------------------------------------+
//| Collect fully closed positions whose last exit is after 'from'.  |
//+------------------------------------------------------------------+
int CollectClosedPositionIds(datetime from, ulong &ids[])
  {
   ArrayResize(ids, 0);
   if(!HistorySelect(from, TimeCurrent() + 86400)) return 0;
   int total = HistoryDealsTotal();
   for(int i = 0; i < total; i++)
     {
      ulong deal = HistoryDealGetTicket(i);
      if(deal == 0) continue;
      long entry = HistoryDealGetInteger(deal, DEAL_ENTRY);
      long type  = HistoryDealGetInteger(deal, DEAL_TYPE);
      if(type != DEAL_TYPE_BUY && type != DEAL_TYPE_SELL) continue; // skip balance/credit
      if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_OUT_BY) continue;
      ulong pid = (ulong)HistoryDealGetInteger(deal, DEAL_POSITION_ID);
      bool seen = false;
      for(int k = 0; k < ArraySize(ids); k++) if(ids[k] == pid) { seen = true; break; }
      if(!seen) { int n = ArraySize(ids); ArrayResize(ids, n + 1); ids[n] = pid; }
     }
   return ArraySize(ids);
  }

// Builds the JSON object for one closed position. Returns "" to skip.
string PositionJson(ulong pid)
  {
   if(PositionSelectByTicket(pid)) return "";      // still (partly) open
   if(!HistorySelectByPosition(pid)) return "";
   int n = HistoryDealsTotal();
   double inVol = 0, inPx = 0, outVol = 0, outPx = 0, commission = 0, swap = 0, profit = 0, sl = 0, tp = 0;
   datetime openT = 0, closeT = 0;
   string symbol = "", side = "";
   for(int i = 0; i < n; i++)
     {
      ulong d = HistoryDealGetTicket(i);
      if(d == 0) continue;
      long type  = HistoryDealGetInteger(d, DEAL_TYPE);
      if(type != DEAL_TYPE_BUY && type != DEAL_TYPE_SELL) continue;
      long entry = HistoryDealGetInteger(d, DEAL_ENTRY);
      double vol = HistoryDealGetDouble(d, DEAL_VOLUME);
      double px  = HistoryDealGetDouble(d, DEAL_PRICE);
      datetime t = (datetime)HistoryDealGetInteger(d, DEAL_TIME);
      commission += HistoryDealGetDouble(d, DEAL_COMMISSION) + HistoryDealGetDouble(d, DEAL_FEE);
      swap       += HistoryDealGetDouble(d, DEAL_SWAP);
      profit     += HistoryDealGetDouble(d, DEAL_PROFIT);
      if(entry == DEAL_ENTRY_INOUT) return "";       // position reversal: not supported, skip
      if(entry == DEAL_ENTRY_IN)
        {
         if(symbol == "") symbol = HistoryDealGetString(d, DEAL_SYMBOL);
         if(side == "")   side = (type == DEAL_TYPE_BUY) ? "buy" : "sell";
         if(openT == 0 || t < openT) openT = t;
         inPx  += px * vol; inVol += vol;
         if(sl == 0) sl = HistoryDealGetDouble(d, DEAL_SL);
         if(tp == 0) tp = HistoryDealGetDouble(d, DEAL_TP);
        }
      else
        {
         if(t > closeT) closeT = t;
         outPx += px * vol; outVol += vol;
        }
     }
   if(inVol <= 0 || outVol <= 0 || symbol == "" || side == "") return "";
   string j = "{";
   j += "\"ticket\":\"" + IntegerToString((long)pid) + "\",";
   j += "\"symbol\":\"" + JsonEscape(symbol) + "\",";
   j += "\"type\":\"" + side + "\",";
   j += "\"volume\":" + Num(inVol, 4) + ",";
   j += "\"open_time\":" + IntegerToString((long)openT) + ",";
   j += "\"close_time\":" + IntegerToString((long)closeT) + ",";
   j += "\"open_price\":" + Num(inPx / inVol) + ",";
   j += "\"close_price\":" + Num(outPx / outVol) + ",";
   j += "\"sl\":" + Num(sl) + ",";
   j += "\"tp\":" + Num(tp) + ",";
   j += "\"commission\":" + Num(commission, 2) + ",";
   j += "\"swap\":" + Num(swap, 2) + ",";
   j += "\"profit\":" + Num(profit, 2);
   j += "}";
   return j;
  }

bool SendBatch(string items, int count, int &imported)
  {
   long offset = (long)(TimeTradeServer() - TimeGMT());
   string payload = "{\"account\":{";
   payload += "\"login\":\"" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + "\",";
   payload += "\"server\":\"" + JsonEscape(AccountInfoString(ACCOUNT_SERVER)) + "\",";
   payload += "\"company\":\"" + JsonEscape(AccountInfoString(ACCOUNT_COMPANY)) + "\",";
   payload += "\"currency\":\"" + JsonEscape(AccountInfoString(ACCOUNT_CURRENCY)) + "\",";
   payload += "\"balance\":" + Num(AccountInfoDouble(ACCOUNT_BALANCE), 2) + ",";
   payload += "\"trade_mode\":\"" + TradeMode() + "\",";
   payload += "\"server_gmt_offset_sec\":" + IntegerToString(offset);
   payload += "},\"positions\":[" + items + "]}";
   string body;
   int code = Http("POST", "/api/mt5/positions", payload, body);
   if(code != 200)
     {
      g_lastStatus = "Sync failed (" + IntegerToString(code) + "): " + body;
      Print("TradeOS: ", g_lastStatus);
      return false;
     }
   // Read "imported":N from the response
   int p = StringFind(body, "\"imported\":");
   if(p >= 0) imported += (int)StringToInteger(StringSubstr(body, p + 11, 8));
   return true;
  }

void SyncNow()
  {
   // Sync right after a deal, and at least every 10 minutes as a safety net.
   if(!g_pending && g_lastOkSync > 0 && TimeCurrent() - g_lastOkSync < 600) return;
   datetime from = (g_lastOkSync == 0) ? TimeCurrent() - InpDaysBack * 86400 : g_lastOkSync - 3 * 86400;
   ulong ids[];
   int total = CollectClosedPositionIds(from, ids);
   string items = "";
   int inBatch = 0, sent = 0, imported = 0;
   bool ok = true;
   for(int i = 0; i < total && ok; i++)
     {
      string j = PositionJson(ids[i]);
      if(j == "") continue;
      items += (inBatch > 0 ? "," : "") + j;
      inBatch++;
      if(inBatch >= BATCH_SIZE)
        {
         ok = SendBatch(items, inBatch, imported);
         sent += inBatch; items = ""; inBatch = 0;
        }
     }
   if(ok) ok = SendBatch(items, inBatch, imported);  // also sends an empty batch as a heartbeat
   sent += inBatch;
   if(ok)
     {
      g_lastOkSync = TimeCurrent();
      g_pending = false;
      g_lastStatus = "Last sync " + TimeToString(TimeLocal(), TIME_DATE | TIME_MINUTES) + " - checked " + IntegerToString(sent) + " closed positions, " + IntegerToString(imported) + " new.";
      if(imported > 0) Print("TradeOS: ", g_lastStatus);
     }
   Comment("TradeOS Sync\n", g_lastStatus);
  }
//+------------------------------------------------------------------+
