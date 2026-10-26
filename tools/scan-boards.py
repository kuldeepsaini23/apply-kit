"""Pull live jobs from Ashby / Greenhouse / Lever boards, Wellfound and Himalayas, and keep the ones that fit your profile.
Usage: python tools/scan-boards.py out.json   (edit the slug lists and filters for your profile)"""
import datetime, json, re, sys, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

ASHBY = """composio sarvam atlys notion supabase cursor elevenlabs plane level-ai linear posthog railway mastra clerk resend neon
cal dub trigger browserbase e2b langchain llamaindex pinecone replit lovable ramp rippling deel retool vapi bland
krutrim rocketlane spotdraft gupshup exotel jar fi smallcase dukaan shiprocket cars24 spinny scaler zepto swiggy
meesho cred groww slice upstox rapido porter urbancompany physicswallah unacademy leena observeai yellowai haptik
hasura appsmith tooljet chargebee darwinbox druva sprinklr airwallex plaid mercury brex vercel modal baseten
together fireworks anyscale cohere mistral perplexity glean harvey sierra decagon writer jasper runway pika
pipedream n8n zapier make airtable coda clickup monday asana miro canva figma framer webflow descript loom
hightouch census rudderstack segment amplitude mixpanel heap statsig launchdarkly growthbook flagsmith
sentry honeycomb grafana temporal inngest upstash convex xata turso planetscale prisma drizzle zod
openrouter portkey helicone langfuse braintrust arize weights-and-biases humanloop
gushwork emergent tsenta cardboard aiprise answerthis infer lab0 feather hud rivet supero""".split()
GREENHOUSE = """postman browserstack gitlab devrev stackblitz singlestore coinbase mongodb elastic hashicorp cloudflare
datadog stripe twilio okta airbnb dropbox robinhood discord reddit pinterest instacart doordash lyft
razorpay phonepe zeta paytm mindtickle whatfix hevodata plivo innovaccer freshworks zomato blinkit
nykaa lenskart myntra cleartax upgrad eruditus khatabook dunzo ola""".split()
LEVER = """gohighlevel gushwork razorpay cred meesho zeta groww upstox slice jar rapido porter urbancompany spotdraft
leena plivo hevodata whatfix mindtickle chargebee paytm swiggy zepto atlan sigmoid juspay setu m2p
dream11 games24x7 mpl sharechat dailyhunt inshorts pocketfm kukufm stagehq toplyne trell""".split()

LOC_OK = re.compile(r"india|bengaluru|bangalore|delhi|gurgaon|gurugram|noida|hyderabad|pune|mumbai|chennai|remote|anywhere|global|apac|asia", re.I)
LOC_OPEN = re.compile(r"\b(remote|anywhere|global|globally|worldwide|apac|asia|hybrid|distributed|flexible|work from home|wfh|first|only|friendly)\b", re.I)
LOC_BAD = re.compile(r"\b(us|usa|united states|americas|north america|emea|europe|uk|united kingdom|canada|latam|germany|france|london|new york|san francisco|seattle|austin|toronto|berlin|amsterdam|dublin|singapore|tokyo|sydney|ljubljana)\b", re.I)
TITLE_OK = re.compile(r"engineer|developer|\bsde\b|programmer", re.I)
TITLE_FIT = re.compile(r"full[ -]?stack|back[ -]?end|front[ -]?end|software|\bai\b|agent|platform|product engineer|forward deployed|founding|node|typescript|web|applied|integrations?|solutions? engineer|\bsde\b|member of technical staff", re.I)
TITLE_BAD = re.compile(r"senior|distinguished|\bjava\b|django|flutter|\brust\b|\.net|robotics|sr\.?\b|staff|principal|lead\b|manager|director|head\b|architect|intern|research|scientist|android|\bios\b|mobile|\bqa\b|test|sdet|\bsre\b|devops|security|embedded|hardware|firmware|sales|support|devrel|developer relations|data engineer|ml engineer|machine learning|analytics|kernel|performance engineer|infra(structure)?\b|network|database|postgres|compiler|gpu|iii\b|\b3\b|apprentice|trainee|contract to hire", re.I)

def get(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36"}), timeout=20) as r:
            return json.load(r)
    except Exception:
        return None

def ashby(slug):
    d = get(f"https://api.ashbyhq.com/posting-api/job-board/{slug}")
    return [dict(ats="ashby", company=slug, title=j["title"], location=" / ".join([j.get("location") or ""] + [s.get("location", "") for s in j.get("secondaryLocations") or []]),
                 remote=j.get("isRemote"), posted=(j.get("publishedAt") or "")[:10], url=j["jobUrl"], apply=j.get("applyUrl") or j["jobUrl"] + "/application")
            for j in (d or {}).get("jobs", []) if j.get("isListed", True)]

def greenhouse(slug):
    d = get(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs")
    return [dict(ats="greenhouse", company=slug, title=j["title"], location=j["location"]["name"], remote=None,
                 posted=(j.get("updated_at") or "")[:10], url=j["absolute_url"], apply=j["absolute_url"]) for j in (d or {}).get("jobs", [])]

def lever(slug):
    d = get(f"https://api.lever.co/v0/postings/{slug}?mode=json")
    if not isinstance(d, list):
        return []
    return [dict(ats="lever", company=slug, title=j["text"], location=(j.get("categories") or {}).get("location", "") + " " + (j.get("workplaceType") or ""),
                 remote=None, posted=datetime.datetime.fromtimestamp(j.get("createdAt", 0) / 1000, datetime.timezone.utc).strftime("%Y-%m-%d"),
                 url=j["hostedUrl"], apply=j.get("applyUrl") or j["hostedUrl"] + "/apply") for j in d]

# Wellfound has no API; its public role pages (allowed by its robots.txt) embed the listings as JSON.
# Fetched one at a time with a pause, and only these few pages.
WELLFOUND = ["role/l/full-stack-engineer/india", "role/l/software-engineer/india", "role/l/backend-engineer/india",
             "role/l/frontend-engineer/india", "role/r/full-stack-engineer", "role/r/software-engineer", "role/r/backend-engineer"]
HIMALAYAS = ["full stack", "backend engineer", "frontend engineer", "software engineer", "ai engineer", "typescript"]

def get_text(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36"}), timeout=30) as r:
            return r.read().decode("utf-8", "replace")
    except Exception:
        return ""

def wellfound(path):
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', get_text(f"https://wellfound.com/{path}"), re.S)
    try:
        data = json.loads(m.group(1))["props"]["pageProps"]["apolloState"]["data"]
    except Exception:
        return []
    company = {}
    for k, s in data.items():
        if k.startswith("StartupResult:"):
            refs = s.get("highlightedJobListings") or []
            for r in refs if isinstance(refs, list) else [refs]:
                company[r.get("__ref")] = s.get("name") or s.get("slug") or ""
    out = []
    for k, j in data.items():
        if not k.startswith("JobListingSearchResult:"):
            continue
        names = j.get("locationNames") or []
        names = [names] if isinstance(names, str) else names
        if j.get("remote"):
            where = list(dict.fromkeys(j.get("acceptedRemoteLocationNames") or []))
            loc = "Remote" + (f" ({', '.join(where)})" if where else "") + (" / " + " / ".join(names) if names else "")
        else:
            loc = " / ".join(names)
        out.append(dict(ats="wellfound", company=company.get(k, ""), title=j.get("title", ""), location=loc, remote=j.get("remote"),
                        posted=datetime.datetime.fromtimestamp(j.get("liveStartAt") or 0, datetime.timezone.utc).strftime("%Y-%m-%d"),
                        url=f"https://wellfound.com/jobs/{j['id']}-{j.get('slug', '')}", apply=f"https://wellfound.com/jobs/{j['id']}-{j.get('slug', '')}",
                        years=j.get("yearsExperienceMin")))
    return out

def himalayas(q, country):
    params = {"q": q, "sort": "recent", **({"country": country} if country else {"worldwide": "true"})}
    d = get("https://himalayas.app/jobs/api/search?" + urllib.parse.urlencode(params))
    return [dict(ats="himalayas", company=j.get("companyName", ""), title=j.get("title", ""),
                 location=" / ".join(j.get("locationRestrictions") or []) or "Remote (worldwide)", remote=True,
                 posted=datetime.datetime.fromtimestamp(j.get("pubDate") or 0, datetime.timezone.utc).strftime("%Y-%m-%d"),
                 url=j.get("guid") or j.get("applicationLink"), apply=j.get("applicationLink") or j.get("guid"),
                 senior="Senior" in (j.get("seniority") or []))
            for j in (d or {}).get("jobs", [])]

def fits(j):
    t = j["title"]
    if (j.get("years") or 0) >= 5 or j.get("senior"):
        return False
    # Wellfound and Himalayas keep old posts up; skip anything older than ~3 months.
    if j["ats"] in ("wellfound", "himalayas") and j["posted"] < (datetime.date.today() - datetime.timedelta(days=90)).isoformat():
        return False
    if not TITLE_OK.search(t) or not TITLE_FIT.search(t) or TITLE_BAD.search(t):
        return False
    return True

INDIA = re.compile(r"india|bengaluru|bangalore|delhi|gurgaon|gurugram|noida|hyderabad|pune|mumbai|chennai", re.I)

def region(j):
    """india: an Indian city or India. remote: only "open" words (Remote, Global, APAC...).
    abroad: anything tied to another country, like "London" or "Remote - US"."""
    loc = j["location"] or ""
    if INDIA.search(loc):
        return "india"
    rest = LOC_OPEN.sub(" ", loc)
    if LOC_OK.search(loc) and not LOC_BAD.search(loc) and not re.search(r"[a-z]", rest, re.I):
        return "remote"
    return "abroad"

def main():
    jobs = []
    with ThreadPoolExecutor(24) as ex:
        for res in ex.map(ashby, ASHBY): jobs += res
        for res in ex.map(greenhouse, GREENHOUSE): jobs += res
        for res in ex.map(lever, LEVER): jobs += res
        for res in ex.map(lambda a: himalayas(*a), [(q, c) for q in HIMALAYAS for c in ("IN", None)]): jobs += res
    for path in WELLFOUND:
        jobs += wellfound(path)
        time.sleep(2)
    # The same role often shows up on a company board and on Wellfound/Himalayas: keep the first.
    seen, out = set(), []
    for j in jobs:
        key = (j["company"].lower().replace(" ", "").replace("-", ""), j["title"].lower())
        if fits(j) and j["url"] and j["url"] not in seen and key not in seen:
            seen.update([j["url"], key]); out.append({**j, "region": region(j)})
    out.sort(key=lambda j: (not re.search(r"delhi|gurgaon|gurugram|noida", j["location"], re.I), j["posted"] or "0"), reverse=False)
    json.dump(out, open(sys.argv[1], "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    by = {r: sum(1 for j in out if j["region"] == r) for r in ("india", "remote", "abroad")}
    print(f"{len(jobs)} jobs scanned, {len(out)} fit ({by['india']} India, {by['remote']} remote, {by['abroad']} abroad)")
    for j in out:
        print(f"{j['ats'][:2]} | {j['region'][:2]} | {j['company'][:14]:14} | {j['title'][:55]:55} | {j['location'][:40]:40} | {j['posted']}")


if __name__ == "__main__":
    main()
