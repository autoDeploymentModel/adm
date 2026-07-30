# -*- coding: utf-8 -*-
# 只读方式查询 admAgent.db，提取最近的 bash / lsp_diagnostics 工具调用结果
import sqlite3, json, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

db = r"C:\Users\admin\Desktop\test\.admAgent\admAgent.db"
con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
cur = con.cursor()
cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
print("tables:", [r[0] for r in cur.fetchall()])

# messages 表结构
cur.execute("PRAGMA table_info(messages)")
cols = [r[1] for r in cur.fetchall()]
print("messages cols:", cols)

cur.execute("SELECT id, role, parts, created_at FROM messages ORDER BY created_at DESC LIMIT 200")
rows = cur.fetchall()
found = 0
for mid, role, parts, ts in rows:
    if not parts:
        continue
    try:
        pl = json.loads(parts)
    except Exception:
        continue
    for p in pl if isinstance(pl, list) else []:
        t = p.get("type", "")
        d = p.get("data", p)
        name = d.get("name") or d.get("tool_name") or ""
        if name in ("bash", "lsp_diagnostics"):
            content = str(d.get("content") or d.get("result") or d.get("input") or "")[:600]
            print("=" * 60)
            print(f"ts={ts} role={role} type={t} tool={name}")
            print(content)
            found += 1
            if found > 25:
                sys.exit(0)
print("total found:", found)
