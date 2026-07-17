#!/usr/bin/env python3
"""
Parse a Twilio call-log CSV export into weekly Advosy scorecard call metrics.

Usage:  python3 parse_twilio_calls.py <calls.csv>
   - Input may be a raw Twilio CSV, OR the Drive-connector download JSON
     ({"content": <base64 csv>, ...}). Both are auto-detected.

Output (stdout): a CALLSEED JSON map  weekNumber -> [inbound % answered, outbound calls made]
combined across the 4 Twilio-tracked brands (VRZA, Pestkee, Bloque, Select).
Everest is excluded (its calls run through Podium, not Twilio).

Attribution (locked):
  pestkee  : 480-360-7376
  bloque   : 602-860-6402, 520-600-6262
  vrza     : 602-610-6098, 520-503-2800, 702-500-1883   (Advosy Construction)
  select   : 520-214-9920
  ADVOSY MESA backup 480-637-5224 -> split EVENLY across the 4 brands (largest remainder)
  IGNORE   : 480-771-5775 (Master Service Line), 480-999-9457 (Recruiting)
Weeks are Tuesday-anchored, Week 1 = first Tuesday of the year (2026-01-06).
"""
import sys, json, base64, csv, io, datetime, collections

def load_csv(path):
    raw = open(path, "r", encoding="utf-8", errors="replace").read()
    s = raw.lstrip()
    if s.startswith("{"):                      # Drive-connector JSON wrapper
        obj = json.loads(raw)
        return base64.b64decode(obj["content"]).decode("utf-8", "replace")
    return raw

def n10(s):
    d = "".join(c for c in (s or "") if c.isdigit())
    return d[-10:] if len(d) >= 10 else None

NUM2BID = {
    "4803607376": "pestkee",
    "6028606402": "bloque", "5206006262": "bloque",
    "6026106098": "vrza", "5205032800": "vrza", "7025001883": "vrza",
    "5202149920": "select",
}
SPLIT = "4806375224"
IGNORE = {"4807715775", "4809999457"}
BRANDS = ["vrza", "pestkee", "bloque", "select"]
FIRST_TUE = datetime.date(2026, 1, 6)

def week_start(d): return d - datetime.timedelta(days=(d.weekday() - 1) % 7)
def wknum(ws): return ((ws - FIRST_TUE).days // 7) + 1
def pdate(startfield): return datetime.date.fromisoformat(startfield.strip().split()[-1])

def distribute(total):
    base, rem = total // 4, total - (total // 4) * 4
    alloc = {b: base for b in BRANDS}
    for b in BRANDS[:rem]: alloc[b] += 1
    return alloc

def main(path):
    rows = list(csv.reader(io.StringIO(load_csv(path))))
    rows = rows[1:]  # drop header
    M = collections.defaultdict(lambda: collections.defaultdict(lambda: [0, 0, 0, 0]))  # bid->wk->[ibr,iba,ibm,obm]
    SP = collections.defaultdict(lambda: [0, 0, 0, 0])
    for r in rows:
        if len(r) < 22: continue
        start, frm, to, direction, status, typ, parent = r[2], r[5], r[6], r[7], r[11], r[16], r[20]
        try: d = pdate(start)
        except Exception: continue
        w = wknum(week_start(d))
        if w < 1 or w > 52: continue
        if direction == "Incoming" and typ == "Phone" and (not parent or parent == "null"):
            num = n10(to)
            if num in IGNORE: continue
            ans = 1 if status == "Completed" else 0
            if num == SPLIT:
                SP[w][0] += 1; SP[w][1] += ans; SP[w][2] += (0 if ans else 1)
            elif num in NUM2BID:
                b = NUM2BID[num]; M[b][w][0] += 1; M[b][w][1] += ans; M[b][w][2] += (0 if ans else 1)
        elif direction == "Outgoing Dial" and typ == "Phone":
            num = n10(frm)
            if num in IGNORE: continue
            if num == SPLIT: SP[w][3] += 1
            elif num in NUM2BID: M[num and NUM2BID[num]][w][3] += 1
    # distribute Advosy-Mesa backup line evenly across the 4 brands
    for w, vals in SP.items():
        for mi in range(4):
            if vals[mi] == 0: continue
            al = distribute(vals[mi])
            for b in BRANDS: M[b][w][mi] += al[b]
    # collapse to dept-level [inbound % answered, outbound made]
    weeks = sorted({w for b in M for w in M[b]})
    seed = {}
    for w in weeks:
        inb = sum(M[b][w][0] for b in BRANDS if w in M[b])
        ans = sum(M[b][w][1] for b in BRANDS if w in M[b])
        ob  = sum(M[b][w][3] for b in BRANDS if w in M[b])
        seed[str(w)] = [round(100 * ans / inb, 1) if inb else 0, ob]
    print(json.dumps(seed, separators=(",", ":")))

if __name__ == "__main__":
    main(sys.argv[1])
