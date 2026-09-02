# -*- coding: utf-8 -*-
"""
职得 · 腾讯文档智能表格（多数据源）→ jobs.json 同步脚本
=========================================================
数据链路（已验证，2026-08-04 完成对接）：
  数据源1「校招信息聚合平台」—— 文档「27届实习提前批信息汇总」
    https://docs.qq.com/smartsheet/DTkRMUVhoUWJXZEhJ
    └─ 核心两个子表(sheet)：
        tTNjGc 「27届内推汇总」      (~100 条)
        tvVDZj 「实习提前批每日更新」 (~1600 条)

  数据源2「27届秋招内推（优先投）」—— 文档「27届秋招含提前批内推-日更（优先投）」
    https://docs.qq.com/smartsheet/DTEhaVEpHaUJzTGRh
    └─ ttTHLZ 「秋招提前批内推（日更）」 (~300 条)
      字段与数据源1不同（企业名称/招聘岗位/工作地点/内推类型/所在行业/内推链接…），
      由独立映射函数 to_row_intern() 清洗转换。

读取通道（破解 opendoc 接口，无需登录/无需代理）：
  GET https://docs.qq.com/dop-api/opendoc?id=<padId>&subId=<sheetId>&startrow=0&endrow=N
  └─ 返回 JSONP → clientVars.collab_client_vars.initialAttributedText.text[0].smartsheet
        └─ base64 → zlib raw deflate 解压 → JSON（rows[0]=[meta,data]）
              └─ meta.c.k3.k3 字段定义 / data.c.k2.k1 记录值

输出：仓库根目录 jobs.json  ——  GitHub Pages(wlunan.github.io/jobworthy/jobs.json)
      以 Access-Control-Allow-Origin:* 提供，页面自动跨域读取最新数据；
      每条记录带 ds（数据源标识），前端「数据源」筛选下拉据此分流展示。

用法：
  python scripts/sync_tencent_docs.py            # 仅生成本地 jobs.json（不推送）
  python scripts/sync_tencent_docs.py --push     # 生成并提交 + push 到 GitHub main
  python scripts/sync_tencent_docs.py --dry      # 仅打印统计，不写文件

扩展新表格数据源：在 SOURCES 中追加一项（pad/子表/字段映射函数/ds），
  并实现对应 mapper（参考 to_row 与 to_row_intern 两种字段形态）。
"""

import sys, os, re, json, base64, zlib, urllib.request, urllib.parse, subprocess, datetime

# ============ 数据源定义 ============
# 字段含义：
#   name   —— 来源文档名（日志用）
#   pad    —— 文档 padId / ref —— Referer
#   ds     —— 数据源标识（写入每条记录，前端 dsFilter 下拉按此分流）
#   sheets —— [(子表ID, 名称, 拉取条数上限), ...]
#   mapper —— 字段映射函数 key（"default"=标准列名表；"intern"=内推优先投表）
SOURCES = [
    {
        "name": "27届实习提前批信息汇总",
        "pad": "DTkRMUVhoUWJXZEhJ",
        "ref": "https://docs.qq.com/smartsheet/DTkRMUVhoUWJXZEhJ",
        "ds": "校招信息聚合平台",
        "sheets": [
            ("tTNjGc", "27届内推汇总", 200),
            ("tvVDZj", "实习提前批每日更新", 2000),
        ],
        "mapper": "default",
    },
    {
        "name": "27届秋招含提前批内推-日更（优先投）",
        "pad": "DTEhaVEpHaUJzTGRh",
        "ref": "https://docs.qq.com/smartsheet/DTEhaVEpHaUJzTGRh",
        "ds": "27届秋招内推（优先投）",
        "sheets": [
            ("ttTHLZ", "秋招提前批内推（日更）", 600),
        ],
        "mapper": "intern",
    },
]
PAGE_SIZE = 300
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"

# ============ 时区 ============
# Tencent 时间戳按 UTC 存储；统一按北京时间（UTC+8）解析/对比，
# 使本机（北京时间）和 GitHub Actions（UTC）跑出来的日期一致。
BJ_TZ = datetime.timezone(datetime.timedelta(hours=8))

def today_bj():
    """返回北京时间（UTC+8）的当天日期。"""
    return datetime.datetime.now(BJ_TZ).date()

CITY_LIST = ["北京","上海","广州","深圳","成都","杭州","武汉","南京","重庆","西安","苏州","天津",
             "长沙","郑州","青岛","东莞","佛山","宁波","无锡","厦门","福州","济南","合肥","昆明",
             "大连","哈尔滨","沈阳","长春","石家庄","太原","南昌","贵阳","南宁","海口","兰州",
             "银川","西宁","呼和浩特","乌鲁木齐","拉萨"]

# ============ 网络 ============
def fetch_sheet_raw(pad_id, sheet_id, rows, ref):
    """请求 opendoc 接口，返回解压后的 JSON 字符串（腾讯文档表格数据）。"""
    params = {
        "u":"", "noEscape":"1", "enableSmartsheetSplit":"1", "supportOptimizedVer":"4",
        "chunkCellSize":"15000", "normal":"1", "outformat":"1", "wb":"1", "nowb":"0",
        "callback":"x", "xsrf":"", "id":pad_id, "subId":sheet_id,
        "startrow":"0", "endrow":str(rows),
    }
    url = "https://docs.qq.com/dop-api/opendoc?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "User-Agent": UA, "Referer": ref, "Accept": "*/*",
    })
    with urllib.request.urlopen(req, timeout=40) as resp:
        text = resp.read().decode("utf-8", "ignore")
    # 去 JSONP 包装：clientVarsCallback({...})
    m = re.match(r"^[^(]*\((.*)\)\s*;?\s*$", text, re.S)
    if not m:
        raise RuntimeError("JSONP 解析失败")
    data = json.loads(m.group(1))
    ccv = data.get("clientVars", {}).get("collab_client_vars", {})
    iat = ccv.get("initialAttributedText", {})
    t = (iat.get("text") or [None])[0]
    if not t or not t.get("smartsheet"):
        raise RuntimeError("无数据字段(smartsheet)")
    b64 = t["smartsheet"].replace("\n", "").replace("\r", "").replace(" ", "")
    raw = base64.b64decode(b64 + "=" * (-len(b64) % 4))  # 补 padding
    inflated = zlib.decompress(raw)  # 标准 zlib（带 zlib 头）
    return inflated.decode("utf-8", "ignore")

# ============ 解析 ============
def field_value(fv, meta):
    """复现前端 tdFieldValue：按字段类型提取可读文本。"""
    if not isinstance(fv, dict):
        return ""
    try:
        t = meta.get("type")
        if t == 1:  # 文本
            arr = fv.get("k1") or []
            if isinstance(arr, list):
                return "".join((x.get("k2") or x.get("k1") or "") for x in arr)
            return str(arr)
        if t == 4:  # 日期时间戳(毫秒) — Tencent 存的是 UTC，统一按 UTC+8（北京）解析
            k4 = fv.get("k4")
            if k4 is not None:
                try:
                    ts = int(k4)
                    sec = ts / 1000 if ts > 1e11 else ts
                    dt = datetime.datetime.fromtimestamp(sec, tz=datetime.timezone.utc).astimezone(BJ_TZ)
                    return dt.strftime("%Y-%m-%d")
                except Exception:
                    pass
            return ""
        if t == 8:  # URL
            arr = fv.get("k8") or fv.get("k1")
            if isinstance(arr, str):
                return arr
            if isinstance(arr, list):
                return " ".join(x.get("k2") for x in arr if isinstance(x, dict) and x.get("k2"))
            return ""
        if t in (9, 17):  # 多选 / 单选
            ids = fv.get("k9") or fv.get("k17") or []
            if isinstance(ids, list):
                return "/".join(meta.get("options", {}).get(i, i) for i in ids)
            return str(ids)
        # 兜底：遍历找文本数组
        for k, v in fv.items():
            if isinstance(v, list) and v:
                texts = [x.get("k2") if isinstance(x, dict) else str(x) for x in v if x]
                if texts:
                    return "/".join(filter(None, texts))
    except Exception:
        pass
    return ""

def parse_sheet(json_str):
    """复现前端 tdParseSheet：返回 [{中文字段名: 值}, ...]。"""
    rows = json.loads(json_str)
    if not rows or not isinstance(rows[0], list) or len(rows[0]) < 2:
        return []
    h0, h1 = rows[0][0], rows[0][1]
    field_defs = ((h0.get("c", {}).get("k3", {}).get("k3")) or {})
    field_meta = {}
    for fid, def_ in field_defs.items():
        if not isinstance(def_, dict):
            continue
        opts = {}
        opt_def = def_.get("k17") or def_.get("k9") or {}
        opt_arr = opt_def.get("k3") if isinstance(opt_def, dict) else None
        if isinstance(opt_arr, list):
            for o in opt_arr:
                if isinstance(o, dict) and o.get("k1") and o.get("k2"):
                    opts[o["k1"]] = o["k2"]
        field_meta[fid] = {"name": def_.get("k30") or fid, "type": def_.get("k31"), "options": opts}
    records = ((h1.get("c", {}).get("k2", {}).get("k1")) or {})
    out = []
    for rid, rec_node in records.items():
        fields = rec_node.get("k1") if isinstance(rec_node, dict) else rec_node
        if not isinstance(fields, dict):
            continue
        rec = {}
        for fid, fv in fields.items():
            meta = field_meta.get(fid)
            if not meta:
                continue
            rec[meta["name"]] = field_value(fv, meta)
        out.append(rec)
    return out

# ============ 字段整理（保留腾讯表格原始行业值）============
def extract_location(text):
    if not text:
        return ""
    if re.search(r"多地|全国|不限地点|工作地不限", text):
        return "多地"
    found = [c for c in CITY_LIST if c in text]
    return "/".join(found[:4])

def is_expired(deadline):
    if not deadline:
        return False
    d = re.sub(r"\s+", " ", str(deadline)).strip()
    if re.search(r"招满即止|招聘中|长期|不限|持续", d):
        return False
    if re.search(r"已结束|已截止|过期|截止$", d):
        return True
    m = re.search(r"(\d{4})[年\/\-.\s]\s*(\d{1,2})[月\/\-.\s]\s*(\d{1,2})日?", d)
    if m:
        try:
            end = datetime.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
            return end < today_bj()
        except Exception:
            pass
    m2 = re.search(r"(\d{1,2})月(\d{1,2})日", d) or re.search(r"^(\d{1,2})[\/\-.](\d{1,2})$", d)
    if m2:
        try:
            now = today_bj()
            end2 = datetime.date(now.year, int(m2.group(1)), int(m2.group(2)))
            return end2 < now
        except Exception:
            pass
    return False

def to_row(r):
    c = (r.get("公司名称") or "").strip()
    p = (r.get("招聘岗位") or "").strip()[:80]
    if not c and not p:
        return None
    deadline = (r.get("招聘截止日期") or "").strip()
    if is_expired(deadline):
        return None
    loc_text = (r.get("工作地点") or "") + " " + (r.get("行业") or "")
    loc = extract_location(loc_text) or extract_location(r.get("工作地点") or "")
    url = (r.get("投递链接or推文") or r.get("投递链接") or "").strip()
    clean_url = url.split()[0] if (url and re.match(r"^https?://", url)) else ""
    announcement = (r.get("官方公告") or "").strip()
    clean_announcement = announcement.split()[0] if (announcement and re.match(r"^https?://", announcement)) else ""
    updated_at = (r.get("更新日期") or "").strip()
    ind = (r.get("行业") or "").strip()
    batch = (r.get("批次") or "").strip()
    title = p if p else (batch or "校招信息")
    return {
        "c": c, "p": title, "l": loc, "e": "",
        "w": batch,
        "d": deadline, "s": "校招信息聚合平台",
        "t": "其他",
        "ind": ind, "ut": updated_at, "a": clean_announcement, "u": clean_url,
    }

# ============ 数据源2：27届秋招内推（优先投）字段映射 ============
# 该表是“内推优先投”渠道，列结构与数据源1不同：
#   企业名称→c   招聘岗位→p   工作地点→l   内推类型→w(批次)   所在行业→ind   内推链接→u
# 无截止/公告/官方更新日期列；公司名常带“(9.1开启）/（8.17新增内推）/（9.1更新）”等维护注释。
# 企业名称里也混有“阿里系-阿里云(8.5开启）仅可内推阿里云”“科大讯飞「星火X计划」…”等描述文案，
# 这类中间括号注释与项目文案尽量保留原样（避免误删公司真名），仅清理行尾的日期类注释。
_company_suffix_re = re.compile(
    r"\s*[\(（][^()（）]*?(?:\d{1,2}[\.／/年]?\d{1,2}日?月?|新增|开启|更新|内推|投递)[^()（）]*?[\)）]\s*$"
)

def clean_company_name(name):
    """清理公司名行尾维护注释：海能达(9.1更新）（8.25开启）→海能达、京东(8.3开启)→京东。"""
    if not name:
        return name
    cur = name
    while True:
        nxt = _company_suffix_re.sub("", cur).strip()
        if nxt == cur:
            break
        cur = nxt
    return cur or name

def to_row_intern(r):
    c_raw = (r.get("企业名称") or "").strip()
    p = (r.get("招聘岗位") or "").strip()[:80]
    if not c_raw and not p:
        return None
    c = clean_company_name(c_raw)
    url = (r.get("（跳转之后复制到浏览器打开）内推链接/官网") or "").strip()
    clean_url = url.split()[0] if (url and re.match(r"^https?://", url)) else ""
    loc = extract_location(r.get("工作地点") or "")
    batch = (r.get("内推类型") or "").strip()
    ind = (r.get("所在行业") or "").strip()
    # 该表无“更新日期”列：ut 记同步当天，便于按更新时间排序/最近筛选
    title = p if p else (batch or "内推岗位")
    return {
        "c": c, "p": title, "l": loc, "e": "",
        "w": batch,
        "d": "",
        "s": "27届秋招内推（优先投）",
        "t": "其他",
        "ind": ind, "ut": today_bj().isoformat(), "a": "", "u": clean_url,
    }

# ============ 主流程 ============
_MAPPERS = {"default": to_row, "intern": to_row_intern}

def run(push=False, dry=False):
    all_rows = []
    for src in SOURCES:
        mapper = _MAPPERS[src["mapper"]]
        seen = set()  # 去重在单个数据源内进行：同源两子表合并去重；跨源保留（渠道不同，页面可按 ds 分流查看）
        print(f"\n[数据源] {src['name']}   (ds={src['ds']})")
        for sheet_id, name, limit in src["sheets"]:
            sheet_ok = False
            print(f"[拉取] {name} ({sheet_id}) ...", end=" ", flush=True)
            for off in range(0, limit, PAGE_SIZE):
                try:
                    js = fetch_sheet_raw(src["pad"], sheet_id, off + PAGE_SIZE, src["ref"])
                    page = parse_sheet(js)
                except Exception as e:
                    print(f"页 {off} 失败: {e}")
                    break
                if not page:
                    break
                sheet_ok = True
                added = 0
                for r in page:
                    row = mapper(r)
                    if not row:
                        continue
                    row["ds"] = src["ds"]
                    key = row["c"] + "|" + row["p"] + "|" + row["l"]
                    if key in seen:
                        continue
                    seen.add(key)
                    all_rows.append(row)
                    added += 1
                print(f"页{off}:{len(page)}条→净增{added}", end="  ", flush=True)
                if added == 0:  # opendoc 每次从 0 返回，无新增即到底
                    break
            print()  # 换行
            if not sheet_ok:
                raise RuntimeError(f"子表拉取失败或无数据，停止覆盖 jobs.json: {name} ({sheet_id}) @ {src['name']}")
        print(f"[本源净增] {src['ds']}: {len(seen)} 条")
    print(f"\n[汇总] 各数据源合并后共 {len(all_rows)} 条有效招聘信息")
    # 数据源分布
    from collections import Counter
    ds_cnt = Counter(x.get("ds") or "" for x in all_rows)
    for k, v in ds_cnt.items():
        print(f"   {k}: {v} 条")
    # 行业分布（整体）
    dist = Counter(x["ind"] for x in all_rows)
    for k, v in dist.most_common():
        print(f"   {k}: {v}")
    if dry:
        return
    out = {
        "updated": today_bj().isoformat(),
        "count": len(all_rows),
        "jobs": all_rows,
    }
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    path = os.path.join(project_root, "jobs.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"\n[jobs.json] 已写入 {path} ({os.path.getsize(path)//1024} KB)")
    if push:
        try:
            subprocess.run(["git", "add", "jobs.json"], cwd=project_root, check=True)
            msg = f"data: sync jobs.json from Tencent Docs ({len(all_rows)} jobs, {out['updated']})"
            subprocess.run(["git", "commit", "-m", msg], cwd=project_root, check=True)
            subprocess.run(["git", "push", "origin", "main"], cwd=project_root, check=True)
            print("[git] 已 commit + push 到 main")
        except subprocess.CalledProcessError as e:
            print(f"[git] 推送失败: {e}")

if __name__ == "__main__":
    push = "--push" in sys.argv
    dry = "--dry" in sys.argv
    run(push=push, dry=dry)
