import json, re, collections, statistics as st
REG=json.load(open("registry_pages2.json")); iid2pg={v["iid"]:k for k,v in REG.items() if v.get("iid")}
P=json.load(open("postiz_threads_all.json")); TM=json.load(open("team_metrics.json"))
ours={e["id"] for e in json.load(open("plog_full.json")) if e.get("id")}
EXTRA_SPORT={"golfaddict_01":"Golf","southpawclub.7":"Boxing","aaronjudgemlbstardom":"MLB","wta.championz":"Tennis","hoops_untold":"NBA","americanolympicupdates":"Olympic"}
def norm_sport(s):
    s=(s or "").strip()
    return {"UFC":"MMA"}.get(s,s)
EMO=re.compile("[\U0001F300-\U0001FAFF☀-➿]")
BAIT=re.compile(r"(?i)[^.!?\n]*\b(comment below|comments below|share your thoughts|drop (a|your)|tag (a|someone|your)|like if|double tap|let us know in the comments|tell us in the comments|sound off)\b[^.!?\n]*[.!?]?\s*(👇|⬇️)?")
LINKLINE=re.compile(r"(?i)\b(read|full|details?|story|link|more|breakdown|report|check)\b.{0,40}\bcomments?\b|\bcomments?\b.{0,20}\b(for|below)\b.{0,20}\b(details?|more|story)\b")
def clean(text):
    t=BAIT.sub("",text)
    t=re.sub(r"[ \t]+\n","\n",t); t=re.sub(r"\n{3,}","\n\n",t).strip()
    return t
team=[]
for p in P:
    if p["id"] in ours or p.get("state")!="PUBLISHED" or p["t"][17:23]!="00.000" or p["id"] not in TM: continue
    m=TM[p["id"]]; c=(p.get("content") or "").strip()
    if not c or re.search(r"(?i)\bthe reply\b|reply's got|in the reply",c): continue  # pipeline-like
    pg=iid2pg.get(p.get("iid"))
    sport=norm_sport((REG[pg]["sports"] or [None])[0]) if pg else norm_sport(EXTRA_SPORT.get(p["acct"]))
    team.append(dict(pg=pg,acct=p["acct"],sport=sport,text=c,clean=clean(c),views=int(m.get("views") or 0),likes=int(m.get("likes") or 0),t=p["t"]))
print("usable team posts:",len(team))
def pick_examples(rows,k=8):
    rows=[r for r in rows if r["views"]>=50 and len(r["clean"])>=40]
    rows.sort(key=lambda r:(-r["likes"],-r["views"]))
    out=[];seen=set()
    for r in rows:
        key=re.sub(r"\W","",r["clean"].lower())[:50]
        if key in seen: continue
        seen.add(key); out.append(r)
        if len(out)>=k: break
    return out
def stats(rows):
    n=len(rows) or 1
    tags=collections.Counter(t for r in rows for t in set(re.findall(r"#\w+",r["text"])))
    has_tag=sum(1 for r in rows if re.search(r"#\w",r["text"]))
    link_lines=collections.Counter()
    for r in rows:
        for line in r["text"].split("\n"):
            if LINKLINE.search(line) and len(line)<80 and not BAIT.search(line) and "?" not in line: link_lines[line.strip()]+=1
    with_link=sum(1 for r in rows if any(LINKLINE.search(l) and not BAIT.search(l) and "?" not in l for l in r["text"].split("\n")))
    body=[re.sub(r"#\w+","",r["clean"]).strip() for r in rows]
    return dict(n=len(rows),
        hashtags=[t for t,c in tags.most_common(6) if c/n>=0.08][:4], hashtag_rate=round(has_tag/n,2),
        emoji_rate=round(sum(1 for r in rows if EMO.search(r["text"]))/n,2),
        question_rate=round(sum(1 for b in body if "?" in b)/n,2),
        median_chars=int(st.median([len(b) for b in body])) if body else 200,
        link_lines=[l for l,c in link_lines.most_common(5)], link_line_rate=round(with_link/n,2))
bysport=collections.defaultdict(list)
for r in team: bysport[r["sport"]].append(r)
profiles={}
for pg,v in REG.items():
    if v["status"]!="active": continue
    own=[r for r in team if r["pg"]==pg]
    sport=norm_sport((v["sports"] or [None])[0])
    ex=pick_examples(own)
    source="own"
    if len(ex)<5:
        pool=[r for r in bysport.get(sport,[]) if r["pg"]!=pg]
        ex=ex+[r for r in pick_examples(pool,12) if r not in ex][:8-len(ex)]
        source="own+sport" if own else "sport"
    if not ex or max(e["likes"] for e in ex) < 15:
        strong=[r for r in team if r["pg"] in ("p78","p74","p51","p92","p52")]
        tone=[r for r in pick_examples(strong,20) if r not in ex][:max(0,8-len(ex))+3]
        ex=(ex+tone)[:10]; source=source+"+tone_examples"
    st_rows=own if len(own)>=15 else (own+bysport.get(sport,[]))
    prof=dict(page_id=pg,page_name=v["name"],sport=sport,source=source,built_from=dict(own_team_posts=len(own),sport_team_posts=len(bysport.get(sport,[]))),
        examples=[dict(text=r["clean"][:450],likes=r["likes"],views=r["views"],from_page=(r["pg"] or r["acct"])) for r in ex],
        **stats(st_rows) if st_rows else {})
    prof["link_line_rate"]=min(0.5,max(0.2,prof.get("link_line_rate",0.25)))
    if not prof.get("link_lines"): prof["link_lines"]=["More details in the comments 👇","Read more in the comments."]
    prof["median_chars"]=max(120,min(300,prof.get("median_chars",220)))
    profiles[pg]=prof
    json.dump(prof,open(f"style_profiles/{pg}.json","w"),indent=1,ensure_ascii=False)
print("profiles:",len(profiles))
for pg in ["p78","p74","p40","p51","p92","p41"]:
    p=profiles.get(pg); 
    if not p: continue
    print(f"\n== {pg} {p['page_name']} source={p['source']} n={p['n']} hashtags={p['hashtags']} tag_rate={p['hashtag_rate']} emoji={p['emoji_rate']} q={p['question_rate']} chars={p['median_chars']} link_rate={p['link_line_rate']} link_lines={p['link_lines'][:3]}")
    for e in p["examples"][:3]: print(f"   [{e['likes']}♥ {e['views']}v {e['from_page']}] {e['text'][:170]!r}")
