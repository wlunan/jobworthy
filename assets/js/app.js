// Xiaozhao Radar main logic (state / render / filter / crawl / applications / import-export)
import { CRAWL_SITES } from "./sites.js";

let D=[],F=[],currentPage=1,pageSize=20,currentSort="updated_desc";
const VIEW_STATE_KEY="xiaozhao_radar_view_state_v1";
const APPLICATIONS_STORAGE_KEY="xiaozhao_radar_applications_v2";
// 数据源标识：当前仅有聚合表格数据；后续接入其他表格岗位数据时，新数据的 ds 字段写对应来源，并在 dsFilter 下拉追加 option
const DEFAULT_DATA_SOURCE="校招信息聚合平台";
let applications=[];

const DEFAULT_FIRECRAWL_KEY = "";



// ★ 打通同步闭环：页面首选从 GitHub Pages 读取 scripts/sync_tencent_docs.py 自动同步的聚合数据 jobs.json
//   jobs.json 结构：{updated:"YYYY-MM-DD", count:N, jobs:[...]}，每条含 s:"校招信息聚合平台" 标记
//   加载成功即作为主数据源直接渲染，使「每周五同步 → 页面自动更新」真正生效；失败则分级回退
async function loadRemoteJobs(){
    try{
        const resp = await fetch("jobs.json", {cache:"no-store"});
        if(!resp.ok) throw new Error("HTTP "+resp.status);
        const obj = await resp.json();
        // 兼容两种格式：数组本身，或 {jobs:[...]} 包装
        const arr = Array.isArray(obj) ? obj : (obj && obj.jobs);
        if(Array.isArray(arr) && arr.length){
            return arr;
        }
    }catch(e){
        console.warn("[校招雷达] jobs.json 加载失败，尝试本地缓存：", e && e.message);
    }
    return null;
}

var SEARCH_FIELD_PLACEHOLDERS={"":"搜索公司、职位、地点或关键词（如：北京 / Java）",c:"搜索公司名称（如：腾讯）",p:"搜索职位名称（如：Java）",l:"搜索地点（如：北京）",ind:"搜索行业（如：互联网科技）",w:"搜索批次（如：2026）",s:"搜索来源（如：互联网）"};

async function init(){
    loadApplications();
    // 1) 首选：GitHub Pages 上每周五同步的聚合数据（打通同步闭环）
    var remote = await loadRemoteJobs();
    if(remote && remote.length){
        D = remote;
        console.log("[校招雷达] 已从 jobs.json 加载 "+D.length+" 条聚合数据");
    } else {
        // 2) 兜底：localStorage 已保存的用户数据
        var saved=localStorage.getItem("xiaozhao_radar_data");
        if(saved){try{D=JSON.parse(saved);}catch(e){D=[];}}
    }
    // 数据源规范化：未带 ds 标记的历史数据统一归入默认数据源
    D.forEach(function(x){if(!x.ds)x.ds=DEFAULT_DATA_SOURCE;});
    restoreViewState();
    filterData(true);
    renderIcons();
    saveData();
}

const NAV_WORDS=["首页","单位一览","应聘指南","帮助中心","更多","我的","登录","注册","个人中心","意见反馈","修改密码","注销","预约","报送","学籍","成绩","上传","获得帮助","技术支持","版权","关于我们","联系我们","站点地图","RSS"];
const JOB_WORDS=["招聘","校招","应届","毕业生","实习","管培","招录","选拔","宣讲","录用","职位","岗位","社招","热招","board","hot","opening","career","job","join","team","热聘"];
// 问答/攻略/介绍类内容过滤：防止把"xxx招聘流程是什么？"这类垃圾当职位
const QA_WORDS=["问答","FAQ","常见问题","招聘流程","面试经验","笔试","攻略","心得","是什么","怎么样","怎么办","薪资待遇","福利待遇","员工福利","企业文化","公司介绍","加入我们","校招日历"];
function extractJobsFromMarkdown(md, siteUrl){
    const links=md.match(/\[[^\]]+\]\([^)]+\)/g)||[];
    const out=[]; const seen={};
    let baseHost="";
    try{ baseHost=new URL(siteUrl).hostname; }catch(e){}
    links.forEach(function(l){
        const m=l.match(/\[([^\]]+)\]\(([^)]+)\)/);
        if(!m) return;
        const text=m[1].trim();
        const url=m[2].trim();
        if(!text || text.length<4 || text.length>80) return;
        if(!JOB_WORDS.some(function(w){return text.toLowerCase().indexOf(w.toLowerCase())>=0;})) return;
        if(NAV_WORDS.some(function(w){return text.indexOf(w)>=0;})) return;
        if(QA_WORDS.some(function(w){return text.indexOf(w)>=0;})) return;
        if(!/^https?:\/\//.test(url)) return;
        try{
            const u=new URL(url);
            // 放宽：baseHost 同站（任意子域名），或 host 命中招聘常见关键词
            const host=u.hostname.toLowerCase();
            const sameSite=baseHost && (host===baseHost || host.endsWith('.'+baseHost));
            const hostOk=/51job|yingjiesheng|zhaopin|sgcc|guopin|job\.|career|recruit|hotjob|campus\.|talent|hr\.|mokahr|zhiye|positions|app\.|lagou|nowcoder/i.test(host);
            const ok=sameSite || hostOk;
            if(!ok) return;
        }catch(e){ return; }
        if(seen[url]) return; seen[url]=1;
        out.push({title:text, url:url});
    });
    // 兜底：无链接时从纯文本行中提取职位标题（很多公司招聘页是 JS 渲染，Firecrawl 抓回来只有纯文本）
    if(!out.length){
        const lines=md.split('\n').map(function(l){return l.trim();}).filter(function(l){return l.length>=6 && l.length<=80;});
        lines.forEach(function(line){
            if(!JOB_WORDS.some(function(w){return line.indexOf(w)>=0;})) return;
            if(NAV_WORDS.some(function(w){return line.indexOf(w)>=0;})) return;
            if(QA_WORDS.some(function(w){return line.indexOf(w)>=0;})) return;
            // 过滤明显不是职位的：行内含 URL、含长数字、含特殊符号
            if(/https?:\/\/|[:：]\s*邮箱|\d{6,}/.test(line)) return;
            if(seen[line]) return; seen[line]=1;
            out.push({title:line, url:siteUrl});
        });
    }
    return out;
}

/* ---- 第一备用：AnySearch（云端免费搜索/抽取，匿名可用，无需本地 CLI）----
 * 注意：api.anysearch.com 不返回 CORS 头，纯前端浏览器直连会被拦截，
 * 因此必须经 CORS 代理转发。以下为多个免费公共代理候选，自动按顺序探测：
 * 1) corsproxy.io（免费层限 localhost/开发环境，本地测试首选）
 * 2) codetabs（原默认，若恢复可用则自动切回）
 * 3) allorigins / whateverorigin（备选）
 * 任一代理连续失败 2 次即标记不可用、自动切换到下一个；
 * 如需更高可靠性/隐私，请用自托管代理（见 README「AnySearch 代理」一节，Node 10 行即可），
 * 或把 localStorage 的 xiaozhao_anysearch_proxy 设为你的代理地址。 */
const ANYSEARCH_PROXIES = [
    "http://localhost:8787/",
    "https://corsproxy.io/?url=",
    "https://api.codetabs.com/v1/proxy/?quest=",
    "https://api.allorigins.win/raw?url=",
    "https://whateverorigin.org/GET?url="
];
function anysearchKey(){
    return (localStorage.getItem("xiaozhao_anysearch_key")||"").trim();
}
// 每个代理的连续失败计数；本地存储自定义代理
let _proxyFail={};
function _proxyFailed(px){_proxyFail[px]=(_proxyFail[px]||0)+1;}
function _proxyOk(px){_proxyFail[px]=0;}
function _activeProxies(){
    // 用户自定义代理优先
    const custom=(localStorage.getItem("xiaozhao_anysearch_proxy")||"").trim();
    const list=custom?[custom]:ANYSEARCH_PROXIES.slice();
    // 过滤掉连续失败>=2 的（除非只剩它一个）
    const live=list.filter(function(p){return _proxyFail[p]<2;});
    return live.length?live:list;
}
async function anysearchExtract(siteUrl){
    // ★ 先探测本地代理是否在线：不在线时提示用户启动 tools/proxy.js（公共代理今天全挂，本地代理是稳定通道）
    const proxies = _activeProxies();
    if(!window.__proxyChecked){
        window.__proxyChecked=true;
        try{
            const probe=await fetch("http://localhost:8787/https://example.com/",{method:"GET",mode:"cors"});
            if(!probe.ok) throw new Error("probe failed");
        }catch(e){
            toast("🛠 AnySearch 备用需要本地代理：请先运行 node tools/proxy.js 后再点爬虫（其他公共代理不稳定）");
        }
    }
    const target = "https://api.anysearch.com/mcp";
    const headers = {"Content-Type":"application/json","X-Anysearch-Client":"skill/3.0.1"};
    const ak = anysearchKey();
    if(ak) headers["Authorization"] = "Bearer "+ak;
    const body = JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"extract",arguments:{url:siteUrl}}});
    let lastErr=null;
    for(let pi=0;pi<proxies.length;pi++){
        const px=proxies[pi];
        const url = px + encodeURIComponent(target);
        try{
            const resp = await fetch(url,{method:"POST",headers:headers,body:body});
            if(!resp.ok){ _proxyFailed(px); lastErr=new Error("AnySearch HTTP "+resp.status); continue; }
            const json = await resp.json();
            if(json.error){ lastErr=new Error(json.error.message||"AnySearch error"); continue; }
            const content = (json.result&&json.result.content)||[];
            let md="";
            for(let i=0;i<content.length;i++){ if(content[i].type==="text"){ md=content[i].text; break; } }
            if(!md){ lastErr=new Error("AnySearch empty result"); continue; }
            _proxyOk(px);
            return extractJobsFromMarkdown(md, siteUrl);
        }catch(e){ _proxyFailed(px); lastErr=e; }
    }
    throw lastErr||new Error("AnySearch all proxies failed");
}

async function firecrawlScrape(siteUrl, key){
    const resp=await fetch("https://api.firecrawl.dev/v1/scrape",{
        method:"POST",
        headers:{"Authorization":"Bearer "+key,"Content-Type":"application/json"},
        body:JSON.stringify({url:siteUrl, formats:["markdown"], onlyMainContent:true})
    });
    if(!resp.ok){
        const err=await resp.json().catch(()=>({}));
        // ★ 429 限流：抛特殊错误，调用方识别后提前结束爬取走兜底（免费额度撑不起全量爬）
        if(resp.status===429) throw new Error("FIRECRAWL_RATELIMIT");
        throw new Error(err.error||("HTTP "+resp.status));
    }    const json=await resp.json();
    const md=(json.data&&json.data.markdown)||"";
    return extractJobsFromMarkdown(md, siteUrl);
}

// 截止日期判断：已过期的记录直接过滤不显示。
function isExpiredDeadline(deadline){
    if(!deadline) return false;
    var d=String(deadline).replace(/\s+/g,' ').trim();
    if(/招满即止|招聘中|长期|不限|持续/.test(d)) return false; // 长期有效
    if(/已结束|已截止|过期|截止$/.test(d)) return true;        // 明确结束
    // 完整日期：2026 06 30 / 2026-06-30 / 2026年6月30日 / 2026/6/30
    var m=d.match(/(\d{4})[年\/\-.\s]\s*(\d{1,2})[月\/\-.\s]\s*(\d{1,2})日?/);
    if(m){
        var end=new Date(+m[1], +m[2]-1, +m[3]);
        if(!isNaN(end.getTime())) return end.getTime() < Date.now();
    }
    // 月日：6月30日 / 06-30（未标年份，按当年判断；若当年已过则视为过期）
    var m2=d.match(/(\d{1,2})月(\d{1,2})日/);
    if(!m2) m2=d.match(/^(\d{1,2})[\/\-.](\d{1,2})$/);
    if(m2){
        var now=new Date();
        var end2=new Date(now.getFullYear(), +m2[1]-1, +m2[2]);
        if(!isNaN(end2.getTime())) return end2.getTime() < Date.now();
    }
    return false; // 无法识别格式，保守保留
}
const CITY_LIST = ["北京","上海","广州","深圳","成都","杭州","武汉","南京","重庆","西安","苏州","天津","长沙","郑州","青岛","东莞","佛山","宁波","无锡","厦门","福州","济南","合肥","昆明","大连","哈尔滨","沈阳","长春","石家庄","太原","南昌","贵阳","南宁","海口","兰州","银川","西宁","呼和浩特","乌鲁木齐","拉萨"];
function extractLocation(text){
  if(/多地|全国|不限地点|工作地不限/.test(text)) return "多地";
  var found=[];
  CITY_LIST.forEach(function(c){ if(text.indexOf(c)>=0) found.push(c); });
  if(found.length) return found.slice(0,4).join("/");
  return "";
}
function extractDeadline(text){
  var m=text.match(/(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?/);
  if(m) return m[1]+"-"+("0"+m[2]).slice(-2)+"-"+("0"+m[3]).slice(-2);
  m=text.match(/(\d{1,2})月(\d{1,2})日/);
  if(m) return ("0"+m[1]).slice(-2)+"-"+("0"+m[2]).slice(-2);
  return "";
}

const INTERNET_COMPANIES=["腾讯","阿里巴巴","字节跳动","美团","百度","京东","华为","小米","网易","拼多多","快手","滴滴","B站","携程","360","搜狐","新浪微博","58同城","腾讯音乐","蚂蚁集团","商汤科技","旷视科技","科大讯飞","大疆创新","OPPO","vivo","荣耀","传音控股","联想","中兴通讯","深信服","用友","金山软件","米哈游","叠纸游戏","莉莉丝游戏","鹰角网络","Shopee","微软中国","苹果中国","谷歌中国","亚马逊中国","IBM中国","甲骨文中国","SAP中国","英特尔中国","英伟达中国","戴尔中国","高通中国","海尔智家"];
const COMPREHENSIVE_SITES=["51job校招","应届生求职网","国聘"];
function getType(cat){
    if(COMPREHENSIVE_SITES.indexOf(cat)>=0) return "综合";
    if(INTERNET_COMPANIES.indexOf(cat)>=0) return "互联网";
    return "央企";
}
function mapResult(r, site){
    const cat=site.cat;
    const title=(r.title||r.p||"招聘信息").toString();
    const text=title;
    return {
        c: cat,
        p: title.slice(0,80),
        l: extractLocation(text),
        w: "",
        d: extractDeadline(text),
        s: cat,
        t: site.t||getType(cat),
        ds: DEFAULT_DATA_SOURCE,
        ind: site.ind||"",
        u: r.url||""
    };
}

// ===== 分批加载：前20站并发抓取立即展示，后台并发继续加载 =====
async function startCrawl(){
    const keyInput=document.getElementById('apiKey');
    // 取值优先级：用户即时输入 > 本地存储 > 内置默认 Key（开箱即用）
    const key=((keyInput.value||"").trim()||localStorage.getItem("xiaozhao_firecrawl_key")||DEFAULT_FIRECRAWL_KEY||"").toLowerCase();
    localStorage.setItem("xiaozhao_firecrawl_key",key);

    // 行业精准定向：只爬选中行业下的站点
    var indSel=document.getElementById('indFilter').value;
    var sites=CRAWL_SITES.filter(function(s){return !indSel||s.ind===indSel;});
    if(!sites.length){toast("该行业暂无站点，请换一个行业");return;}
    var total=sites.length;
    var FIRST_BATCH=Math.min(20,total);
    var CONCURRENCY=5; // 并发数：同时抓5个站，大幅提速（Firecrawl 免费层支持）

    // 地点/关键词定向：搜索框填了内容（如"北京"），抓取结果只保留匹配项
    var kw=(document.getElementById('searchInput').value||"").trim();
    function matchKW(it){
        if(!kw) return true;
        var k=kw.toLowerCase();
        return (it.c||"").toLowerCase().indexOf(k)>=0
            || (it.p||"").toLowerCase().indexOf(k)>=0
            || (it.l||"").toLowerCase().indexOf(k)>=0
            || (it.w||"").toLowerCase().indexOf(k)>=0;
    }

    // ★ 不再全屏遮罩：已有数据保持可见，抓取用顶部细进度条提示
    // 用户看到的是"已有数据 + 新增数据"持续增长，而不是黑屏等待
    var ov=document.getElementById('overlay');
    var lt=document.getElementById('overlayText');
    var pf=document.getElementById('pfill');
    ov.style.display='none'; // 关键：不遮罩
    pf.style.width='0%';

    // 空状态下显示进度条
    var cp=document.getElementById('crawlProgress');
    var cpText=document.getElementById('cpText');
    if(cp)cp.style.display='block';
    function updateCp(extra){
        if(cpText)cpText.textContent='正在抓取 '+doneCount+'/'+total+' 站，已获取 '+all.length+' 条｜'+extra;
    }

    // ★ 保留当前已有数据，爬虫抓到的新数据合并进来，持续增长
    let all=[];
    if(D && D.length){
        D.forEach(function(x){ all.push(x); });
    }
    var doneCount=0;
    var indLabel=indSel||'全部行业';

    function dedup(arr){var seen={};return arr.filter(function(x){if(!x.u||seen[x.u])return false;seen[x.u]=1;return true;});}
    function showData(){
        // ★ 过滤已过期的记录（截止日期已过的不显示）
        all=all.filter(function(x){return !isExpiredDeadline(x.d);});
        all=dedup(all);D=all;F=D.slice();currentPage=1;render();saveData();
        // 空状态时显示爬取进度
        if(!D.length && cp && cp.style.display!=='none'){
            updateCp('继续爬后台...');
        }
    }

    // 并发抓取单个站点（Firecrawl 主选 → AnySearch 备用），返回是否成功
    async function scrapeOne(s){
        try{
            var res=await firecrawlScrape(s.url,key);
            if(!res||!res.length){
                res=await anysearchExtract(s.url);
            }
            if(res) res.forEach(function(r){if(r&&r.url){var it=mapResult(r,s);if(matchKW(it))all.push(it);}});
            return true;
        }catch(e){
            // ★ Firecrawl 限流：抛特殊信号，整个爬取提前终止走兜底（不浪费 856 站逐个重试）
            if(e && e.message==="FIRECRAWL_RATELIMIT") return "RATELIMIT";
            if(/[Uu]nauthorized|Invalid/.test(e.message)) return "BADKEY";
            return false;
        }
    }
    // 并发池：同时跑 CONCURRENCY 个任务
    var rateLimited=false;
    async function crawlRange(startIdx, endIdx, label){
        let idx=startIdx;
        // ★ 抓一站立即刷新一次（不显示遮罩），让用户数据渐进增长
        function tickShow(){
            if(startIdx===0){ showData(); }      // 第一批：每次都刷新
            else if((idx-startIdx) % 5 === 0){ showData(); } // 后台：每 5 站刷一次
        }
        async function worker(){
            while(idx<endIdx){
                if(rateLimited) return "STOP"; // 已限流，不再抓
                const cur=idx++;
                const s=sites[cur];
                doneCount++;
                lt.textContent='正在抓取 ('+doneCount+'/'+total+'): '+s.cat;
                pf.style.width=Math.min(100,(doneCount/total*100))+'%';
                updateCp(label);
                const r=await scrapeOne(s);
                if(r==="RATELIMIT"){ rateLimited=true; return "STOP"; }
                if(r==="BADKEY"){
                    ov.style.display='none';toast("API Key 无效，请更新");return "BADKEY";
                }
                tickShow(); // 每抓完一站立即刷新表格
            }
            return "OK";
        }
        const workers=[];
        for(let w=0;w<CONCURRENCY;w++) workers.push(worker());
        const results=await Promise.all(workers);
        if(results.indexOf("BADKEY")>=0) return "BADKEY";
        return "OK";
    }

    // 第一批：前20个站并发抓，每5站立即刷新一次（用户最快几秒看到数据增长）
    lt.textContent='正在并发抓取前 '+FIRST_BATCH+' 个招聘网站（'+indLabel+'）...';
    var firstStatus=await crawlRange(0, FIRST_BATCH, '首批 '+FIRST_BATCH+' 站并发中...');
    if(firstStatus==="BADKEY") return;
    if(rateLimited){
        toast('Firecrawl 免费额度已用完，已保留当前数据。');
        showData();
        if(cp)cp.style.display='none';
        filterData();
        return;
    }
    showData();
    toast('已抓 '+FIRST_BATCH+' 站，数据累计 '+D.length+' 条，后台继续加载。');

    // 后台加载剩余站点：并发5个，不遮挡页面，每10站刷新表格
    var bgStatus=await crawlRange(FIRST_BATCH, total, '后台并发加载中...');
    if(bgStatus==="BADKEY") return;
    if(rateLimited){
        showData();
        toast('Firecrawl 免费额度已用完，已保留当前数据。');
        if(cp)cp.style.display='none';
        filterData();
        return;
    }

    showData();
    if(cp)cp.style.display='none';
    // ★ 兜底判断：按"当前筛选条件下的有效结果"算，不是抓到的总数
    filterData(); // 应用当前筛选（搜索词/行业），得到筛选后的 F
    toast('全部加载完成，筛选后共 '+F.length+' 条招聘信息。');
}

function saveData(){
    localStorage.setItem("xiaozhao_radar_data",JSON.stringify(D));
}

function jobKey(item){
    return [item.c||"",item.p||"",item.l||"",item.u||""].join("|");
}

function loadApplications(){
    try{
        var saved=JSON.parse(localStorage.getItem(APPLICATIONS_STORAGE_KEY)||"[]");
        applications=Array.isArray(saved)?saved:(Array.isArray(saved.applications)?saved.applications:[]);
    }catch(e){applications=[];}
}

function saveApplications(){
    localStorage.setItem(APPLICATIONS_STORAGE_KEY,JSON.stringify(applications));
}

function isManaged(item){
    return !!getApplication(item);
}

function getApplication(item){
    var key=jobKey(item);
    return applications.find(function(app){return app.jobKey===key;});
}

function isExcluded(item){
    var app=getApplication(item);
    return !!app&&app.status==="已排除";
}

function addToApplications(encodedKey,status){
    var key=decodeURIComponent(encodedKey);
    var item=D.find(function(job){return jobKey(job)===key;});
    if(!item){toast("未找到岗位");return;}
    var existing=getApplication(item);
    if(existing){
        if(existing.status==="已排除"&&status!=="已排除"){
            existing.status="准备投递";
            existing.updatedAt=new Date().toISOString();
            saveApplications();
            render();
            toast("已移回投递管理");
            return;
        }
        if(status==="已排除"&&existing.status!=="已排除"){
            existing.status="已排除";
            existing.updatedAt=new Date().toISOString();
            saveApplications();
            render();
            toast("已标记为不考虑");
            return;
        }
        window.location.href="applications.html";
        return;
    }
    var now=new Date().toISOString();
    applications.unshift({
        id:(window.crypto&&crypto.randomUUID)?crypto.randomUUID():(Date.now()+"-"+Math.random().toString(16).slice(2)),
        jobKey:key,
        company:item.c||"",
        position:item.p||"",
        channel:"官网",
        status:status||"准备投递",
        appliedAt:"",
        firstInterviewAt:"",
        note:"",
        job:{location:item.l||"",batch:item.w||"",jobUpdatedAt:item.ut||"",deadline:item.d||"",announcementUrl:item.a||"",applyUrl:item.u||"",source:item.s||""},
        createdAt:now,
        updatedAt:now
    });
    saveApplications();
    render();
    toast(status==="已排除"?"已标记为不考虑":"已加入投递管理");
}

function clearAll(){
    if(!D.length)return;if(confirm("确定清空？")){D=[];F=[];render();saveData();toast("已清空");}
}

function esc(s){
    return (s||"").replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/'/g,"&#39;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function toggleCellExpand(button){
    if(button.dataset.truncated!=='true') return;
    var expanded=button.getAttribute("aria-expanded")==="true";
    var next=!expanded;
    button.setAttribute("aria-expanded",String(next));
    button.querySelector('.cell-expand-text').textContent=next?button.dataset.full:button.dataset.preview;
}

function collapsibleCell(value, limit, className){
    var text=String(value||"-");
    var truncated=text.length>limit;
    var preview=truncated?text.slice(0,limit)+"…":text;
    var classes="cell-expand"+(className?" "+className:"");
    return '<button type="button" class="'+classes+'" aria-expanded="false" data-truncated="'+truncated+'" data-full="'+esc(text)+'" data-preview="'+esc(preview)+'" title="'+esc(text)+'" onclick="toggleCellExpand(this)"><span class="cell-expand-text">'+esc(preview)+'</span>'+(truncated?'<i data-lucide="chevron-down"></i>':'')+'</button>';
}

function renderIcons(){
    if(window.lucide)window.lucide.createIcons({attrs:{"aria-hidden":"true"}});
}

function editCell(cell,idx,f){
    var inp=document.createElement("input");
    inp.type="text";inp.value=cell.dataset.full||cell.textContent||"";
    inp.style.cssText="width:100%;border:none;outline:none;background:#fff8e1;font-size:13px";
    if(cell.classList) cell.classList.remove("cell-expand");
    cell.style.whiteSpace="normal";cell.style.overflow="visible";cell.style.textOverflow="clip";
    cell.textContent="";cell.appendChild(inp);inp.focus();inp.select();
    function save(){D[idx][f]=inp.value;saveData();render();}
    inp.onblur=save;
    inp.onkeydown=function(e){if(e.key==="Enter")save();if(e.key==="Escape"){inp.value="";save();}};
}

// ===== 分页渲染 =====
function render(){
    var tb=document.getElementById('tbody');
    var em=document.getElementById('empty');
    var dt=document.getElementById('dataTable');
    var st=document.getElementById('stats');
    var pg=document.getElementById('pagination');
    var pi=document.getElementById('pageInfo');
    st.textContent="共 "+F.length+" 条记录"+(F.length!==D.length?"（已筛选）":"");
    if(!F.length){dt.style.display="none";em.style.display="block";pg.style.display="none";return;}
    dt.style.display="table";em.style.display="none";
    var totalPages=Math.max(1,Math.ceil(F.length/pageSize));
    if(currentPage>totalPages)currentPage=totalPages;
    if(currentPage<1)currentPage=1;
    var startIdx=(currentPage-1)*pageSize;
    var pageData=F.slice(startIdx,startIdx+pageSize);
    pi.textContent="第 "+currentPage+"/"+totalPages+" 页（"+(startIdx+1)+"-"+Math.min(startIdx+pageSize,F.length)+"条）";
    pg.style.display="block";
    var h="";
    pageData.forEach(function(item,i){
        var realIdx=startIdx+i;
        var sc={"互联网":"tag-t","央企":"tag-g","综合":"tag-y"};
        var cls=sc[item.t]||"tag-g";
        h+='<tr>';
        h+='<td style="color:#9ca3b6;font-size:12px">'+(realIdx+1)+'</td>';
        h+='<td><span class="cname" ondblclick="editCell(this,'+realIdx+',\'c\')">'+(item.c||"-")+'</span></td>';
        h+='<td>'+collapsibleCell(item.p,32,'')+'</td>';
        h+='<td>'+collapsibleCell(item.ind,20,'industry-expand')+'</td>';
        h+='<td><span ondblclick="editCell(this,'+realIdx+',\'ut\')">'+(item.ut||"-")+'</span></td>';
        h+='<td><span ondblclick="editCell(this,'+realIdx+',\'w\')">'+(item.w||"-")+'</span></td>';
        h+='<td><span ondblclick="editCell(this,'+realIdx+',\'l\')">'+(item.l||"-")+'</span></td>';
        h+='<td><span ondblclick="editCell(this,'+realIdx+',\'d\')">'+(item.d||"-")+'</span></td>';
        var safeAnnouncement=(item.a&&/^https?:\/\//i.test(item.a))?item.a:'';
        h+='<td>'+(safeAnnouncement?'<a class="link-btn" href="'+safeAnnouncement+'" target="_blank" rel="noopener noreferrer">公告</a>':'-')+'</td>';
        var safeUrl=(item.u&&/^https?:\/\//i.test(item.u))?item.u:'';
        h+='<td>'+(safeUrl?'<a class="link-btn" href="'+safeUrl+'" target="_blank" rel="noopener noreferrer">投递</a>':'-')+'</td>';
        var sourceLabel=item.s==="校招信息聚合平台"?"表格":(item.s||"-");
        h+='<td><span class="'+cls+'">'+sourceLabel+'</span></td>';
        var encodedKey=encodeURIComponent(jobKey(item)).replace(/'/g,"%27");
        var managed=isManaged(item);
        var excluded=isExcluded(item);
        var actionsHtml;
        if(!managed){
            // 未管理：加入管理（主） + 不考虑（次）
            actionsHtml='<button class="manage-btn" onclick="addToApplications(\''+encodedKey+'\')">加入管理</button><button class="exclude-btn" onclick="addToApplications(\''+encodedKey+'\',\'已排除\')" title="标记为不考虑，不再关注">不考虑</button>';
        }else if(excluded){
            // 已排除：状态标签 + 恢复动作
            actionsHtml='<span class="tag tag-s">已排除</span><button class="manage-btn" onclick="addToApplications(\''+encodedKey+'\')" title="恢复为准备投递">恢复</button>';
        }else{
            // 已加入：状态按钮（跳转投递页） + 不考虑（可用，修复原先 disabled 死路）
            actionsHtml='<button class="manage-btn added" onclick="window.location.href=\'applications.html\'">已加入 · 查看</button><button class="exclude-btn" onclick="addToApplications(\''+encodedKey+'\',\'已排除\')" title="标记为不考虑">不考虑</button>';
        }
        h+='<td><div class="manage-actions">'+actionsHtml+'</div></td>';
        h+='</tr>';
    });
    tb.innerHTML=h;
    renderIcons();
}

function changePage(delta){
    currentPage+=delta;
    render();
    saveViewState();
}
function changePageSize(size){
    pageSize=parseInt(size);
    currentPage=1;
    render();
    saveViewState();
}

function filterData(preservePage){
    var sv=document.getElementById("searchInput").value.toLowerCase();
    var sField=document.getElementById("searchField").value;
    var iv=document.getElementById("indFilter").value;
    var sf=document.getElementById("srcFilter").value;
    var dsf=document.getElementById("dsFilter").value;
    var bf=document.getElementById("batchFilter").value.toLowerCase();
    var uf=parseInt(document.getElementById("updatedFilter").value||"0",10);
    var lf=document.getElementById("linkFilter").value;
    var cutoff=uf?new Date(Date.now()-uf*86400000):null;
    F=D.filter(function(item){
        var ms=!sv||(sField?String(item[sField]||"").toLowerCase().includes(sv):(item.c||"").toLowerCase().includes(sv)||(item.p||"").toLowerCase().includes(sv)||(item.l||"").toLowerCase().includes(sv)||(item.ind||"").toLowerCase().includes(sv));
        var ms4=!iv||!item.ind||item.ind===iv;
        var ms2=!sf||!item.t||item.t===sf;
        var ms3=!dsf||(item.ds||DEFAULT_DATA_SOURCE)===dsf;
        var ms5=!bf||(item.w||"").toLowerCase().includes(bf);
        var updatedDate=item.ut?new Date(item.ut):null;
        var ms6=!uf||(updatedDate&&!isNaN(updatedDate.getTime())&&updatedDate>=cutoff);
        var ms7=!lf||(lf==="official"&&item.a)||(lf==="apply"&&item.u)||(lf==="both"&&item.a&&item.u);
        return ms&&ms2&&ms3&&ms4&&ms5&&ms6&&ms7;
    });
    applySort();
    if(preservePage!==true)currentPage=1;
    render();
    saveViewState();
}

function onSearchFieldChange(){
    document.getElementById("searchInput").placeholder=SEARCH_FIELD_PLACEHOLDERS[document.getElementById("searchField").value]||SEARCH_FIELD_PLACEHOLDERS[""];
    filterData();
}

function clearFilters(){
    ["searchInput","searchField","indFilter","srcFilter","dsFilter","batchFilter","updatedFilter","linkFilter"].forEach(function(id){document.getElementById(id).value="";});
    document.getElementById("searchInput").placeholder=SEARCH_FIELD_PLACEHOLDERS[""];
    filterData();
}

function parseDateValue(value){
    if(!value)return NaN;
    var normalized=String(value).trim().replace(/年|月/g,"-").replace(/日/g,"").replace(/[./]/g,"-");
    var time=Date.parse(normalized);
    return isNaN(time)?NaN:time;
}

function compareDates(a,b,field,descending){
    var av=parseDateValue(a[field]),bv=parseDateValue(b[field]);
    if(isNaN(av)&&isNaN(bv))return 0;
    if(isNaN(av))return 1;
    if(isNaN(bv))return -1;
    return descending?bv-av:av-bv;
}

function applySort(){
    if(currentSort==="updated_desc")F.sort(function(a,b){return compareDates(a,b,"ut",true);});
    else if(currentSort==="updated_asc")F.sort(function(a,b){return compareDates(a,b,"ut",false);});
    else if(currentSort==="deadline_asc")F.sort(function(a,b){return compareDates(a,b,"d",false);});
    else if(currentSort==="deadline_desc")F.sort(function(a,b){return compareDates(a,b,"d",true);});
    else if(currentSort==="company_asc")F.sort(function(a,b){return(a.c||"").localeCompare(b.c||"","zh-CN");});
    else if(currentSort==="batch_asc")F.sort(function(a,b){return(a.w||"").localeCompare(b.w||"","zh-CN");});
}

function changeSort(value){
    currentSort=value;
    currentPage=1;
    filterData();
}

function saveViewState(){
    var state={search:document.getElementById("searchInput").value,searchField:document.getElementById("searchField").value,industry:document.getElementById("indFilter").value,source:document.getElementById("srcFilter").value,dataSource:document.getElementById("dsFilter").value,batch:document.getElementById("batchFilter").value,updated:document.getElementById("updatedFilter").value,link:document.getElementById("linkFilter").value,sort:currentSort,page:currentPage,pageSize:pageSize};
    localStorage.setItem(VIEW_STATE_KEY,JSON.stringify(state));
}

function restoreViewState(){
    var state={};try{state=JSON.parse(localStorage.getItem(VIEW_STATE_KEY)||"{}");}catch(e){}
    var values={searchInput:state.search,searchField:state.searchField,indFilter:state.industry,srcFilter:state.source,dsFilter:state.dataSource,batchFilter:state.batch,updatedFilter:state.updated,linkFilter:state.link,sortSelect:state.sort};
    Object.keys(values).forEach(function(id){if(values[id]!==undefined&&document.getElementById(id))document.getElementById(id).value=values[id];});
    currentSort=document.getElementById("sortSelect").value||"updated_desc";
    pageSize=[20,50,100].includes(Number(state.pageSize))?Number(state.pageSize):20;
    currentPage=Math.max(1,Number(state.page)||1);
    document.getElementById("pageSizeSelect").value=String(pageSize);
    document.getElementById("searchInput").placeholder=SEARCH_FIELD_PLACEHOLDERS[document.getElementById("searchField").value]||SEARCH_FIELD_PLACEHOLDERS[""];
}

function csvCell(v){
    var s=String(v==null?"":v);
    if(s.indexOf(",")>=0||s.indexOf("\n")>=0||s.indexOf("\r")>=0||s.indexOf('"')>=0){
        return '"'+s.replace(/"/g,'""')+'"';
    }
    return s;
}
function exportExcel(){
    if(!F.length){toast("没有数据");return;}
    var h=["序号","公司","职位","岗位更新时间","批次","地点","截止日期","官方公告","投递链接","来源"];
    var rows=[];F.forEach(function(item,i){rows.push([i+1,item.c,item.p,item.ut,item.w,item.l,item.d,item.a,item.u,item.s]);});
    var csv=h.map(csvCell).join(",")+"\n";rows.forEach(function(r){csv+=r.map(csvCell).join(",")+"\n";});
    var a=document.createElement("a");a.href="data:text/csv;charset=utf-8,\uFEFF"+encodeURIComponent(csv);a.download="xiaozhao-radar-data.csv";a.click();
    toast("已导出CSV");
}

function handleImport(input){
    var file=input.files[0];
    if(!file){return;}
    var reader=new FileReader();
    reader.onload=function(e){
        try{
            var text=e.target.result;
            var rows;
            if(/\.json$/i.test(file.name)){
                rows=JSON.parse(text);
                if(!Array.isArray(rows)){
                    if(Array.isArray(rows.data)) rows=rows.data;
                    else if(Array.isArray(rows.items)) rows=rows.items;
                    else if(Array.isArray(rows.results)) rows=rows.results;
                    else rows=[rows];
                }
            }else{
                rows=parseCSV(text);
            }
            rows=rows.map(function(r){
                var loc=[r.city,r.district].filter(Boolean).join("/")||r.l||r.location||"";
                var welfare=[(r.salary||r.salaryMin?(r.salary||r.salaryMin):""),r.tags,r.welfare,r.summary].filter(Boolean).join(" ")||r.w||"";
                var company=r.c||r.company||r.companyFull||"";
                return {
                    c: company,
                    p: r.p||r.position||r.title||"",
                    l: loc,
                    ds: r.ds||r.dataSource||DEFAULT_DATA_SOURCE,
                    w: r.w||r.batch||r["批次"]||welfare,
                    d: r.d||r.deadline||r.issueDate||"",
                    s: r.s||r.source||"OpenCLI导入",
                    t: getType(company),
                    ut: r.ut||r.updatedAt||r["更新时间"]||r["岗位更新时间"]||"",
                    a: r.a||r.announcement||r["官方公告"]||"",
                    u: r.u||r.url||r.companyUrl||r.link||""
                };
            }).filter(function(r){return r.c||r.p;});
            if(!rows.length){toast("没有解析到有效记录");input.value="";return;}
            D=rows;F=D.slice();currentPage=1;render();saveData();
            toast("已导入 "+rows.length+" 条记录");
        }catch(err){
            toast("导入失败："+err.message);
        }
        input.value="";
    };
    reader.readAsText(file,"utf-8");
}

function parseCSV(text){
    var lines=text.replace(/\r/g,"").split("\n").filter(function(l){return l.trim()!=="";});
    if(!lines.length)return [];
    var headers=splitCSVLine(lines[0]);
    return lines.slice(1).map(function(line){
        var cols=splitCSVLine(line);
        var o={};headers.forEach(function(h,i){o[h.trim()]=cols[i]!==undefined?cols[i].trim():"";});
        return o;
    });
}
function splitCSVLine(line){
    var out=[],cur="",q=false;
    for(var i=0;i<line.length;i++){
        var ch=line[i];
        if(ch==='"'){q=!q;continue;}
        if(ch===","&&!q){out.push(cur);cur="";continue;}
        cur+=ch;
    }
    out.push(cur);return out;
}

function toast(msg){
    var t=document.getElementById("toast");t.textContent=msg;
    t.classList.add("show");setTimeout(function(){t.classList.remove("show");},3500);
}

// ===== ES module mount: inline HTML handlers need these on window =====
Object.assign(window, {
    exportExcel, handleImport, clearAll,
    onSearchFieldChange, filterData, clearFilters,
    changeSort, changePage, changePageSize,
    editCell, addToApplications, toggleCellExpand, startCrawl
});

init();
