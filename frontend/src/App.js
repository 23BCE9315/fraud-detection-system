import { useEffect, useRef, useState, useCallback } from "react";
import { Network } from "vis-network";
import { DataSet } from "vis-data";
import "./dashboard.css";

const API_BASE = "http://localhost:5000/api";

// ─── Colour palette ───────────────────────────────────────────────────────────
const FC = {
  circular:   { nodeBg:"#3f0000", nodeBorder:"#ef4444", edge:"#ef4444", glow:"rgba(239,68,68,0.5)",  label:"#fca5a5", name:"Circular",   icon:"↺" },
  high_value: { nodeBg:"#3a1005", nodeBorder:"#f97316", edge:"#f97316", glow:"rgba(249,115,22,0.5)", label:"#fed7aa", name:"High-Value", icon:"$" },
  fan_out:    { nodeBg:"#250c52", nodeBorder:"#a855f7", edge:"#a855f7", glow:"rgba(168,85,247,0.5)", label:"#e9d5ff", name:"Fan-Out",    icon:"↗" },
  fan_in:     { nodeBg:"#06200f", nodeBorder:"#22c55e", edge:"#22c55e", glow:"rgba(34,197,94,0.5)",  label:"#bbf7d0", name:"Fan-In",     icon:"↙" },
  normal:     { nodeBg:"#0d2248", nodeBorder:"#3b82f6", edge:"#142035", glow:"rgba(59,130,246,0.3)", label:"#e8edf5", name:"Normal",     icon:"⬡" },
  selected:   { nodeBg:"#5c2900", nodeBorder:"#f59e0b", edge:null,      glow:"rgba(245,158,11,0.5)", label:"#fef3c7", name:"Selected",   icon:"●" },
};

const RC = {
  CRITICAL: { bg:"#3f0000", border:"#ef4444", text:"#fca5a5", bar:"#ef4444" },
  HIGH:     { bg:"#3a1005", border:"#f97316", text:"#fed7aa", bar:"#f97316" },
  MEDIUM:   { bg:"#2a1a00", border:"#f59e0b", text:"#fef3c7", bar:"#f59e0b" },
  LOW:      { bg:"#0c2a1a", border:"#22c55e", text:"#bbf7d0", bar:"#22c55e" },
  CLEAN:    { bg:"#0d2248", border:"#3b82f6", text:"#bfdbfe", bar:"#3b82f6" },
};

const SIG_LABELS = { circular:"↺ Loop", fanOut:"↗ Fan-Out", fanIn:"↙ Fan-In", highValueSent:"$ Sent", highValueReceived:"$ Recv" };

const TEXT_COLOR    = "#dde5f0";
const EDGE_NORMAL   = "#142035";
const ALL_TYPES     = ["circular","high_value","fan_out","fan_in"];
const TYPE_PRIORITY = ["circular","high_value","fan_out","fan_in"];

// ─── vis options ──────────────────────────────────────────────────────────────
const VIS_OPTS = {
  nodes: { shape:"dot", size:22, font:{color:TEXT_COLOR, size:12, face:"'JetBrains Mono',monospace", vadjust:1}, borderWidth:2.5, shadow:{enabled:true, size:18, x:0, y:4, color:"rgba(0,0,0,0.8)"} },
  edges: { arrows:{to:{enabled:true, scaleFactor:0.65}}, smooth:{type:"curvedCW", roundness:0.18}, font:{color:"#1e3255", size:10, face:"'JetBrains Mono',monospace", align:"middle", strokeWidth:0}, hoverWidth:2.5, selectionWidth:3.5 },
  physics: { solver:"forceAtlas2Based", forceAtlas2Based:{gravitationalConstant:-85, centralGravity:0.008, springLength:160, springConstant:0.06, damping:0.6}, stabilization:{iterations:300, updateInterval:25} },
  interaction: { hover:true, tooltipDelay:80, zoomView:true, dragView:true, selectConnectedEdges:true, multiselect:false },
  layout: { improvedLayout:true },
};

// ─── helpers ──────────────────────────────────────────────────────────────────
const domType = (ts) => { for (const t of TYPE_PRIORITY) if (ts.has(t)) return t; return null; };

function tooltip(label, typeSet, amount) {
  const badges = [...typeSet].map(t => { const f=FC[t]; return `<span style="display:inline-flex;align-items:center;gap:4px;margin-top:5px;margin-right:4px;background:${f.nodeBg};border:1px solid ${f.nodeBorder};border-radius:5px;padding:2px 8px;font-size:9.5px;color:${f.label};font-weight:700">${f.icon} ${f.name.toUpperCase()}</span>`; }).join("");
  const amt = amount!=null ? `<div style="margin-top:6px;display:flex;align-items:center;gap:6px"><span style="font-size:9.5px;color:#3d5478">AMOUNT</span><span style="font-size:13px;font-weight:700;color:#e8edf5;font-family:'Outfit',sans-serif">$${Number(amount).toLocaleString()}</span></div>` : "";
  const div = (typeSet.size>0||amount!=null) ? `<div style="margin:8px 0 4px;height:1px;background:linear-gradient(90deg,transparent,rgba(30,54,96,0.8),transparent)"></div>` : "";
  return `<div style="min-width:140px"><div style="font-size:13px;font-weight:600;color:#eef2f8;font-family:'Outfit',sans-serif">${label}</div>${div}${amt}${badges?`<div style="display:flex;flex-wrap:wrap;gap:2px">${badges}</div>`:""}</div>`;
}

function buildVisData(graphData, fraud) {
  const nm = new Map(), em = new Map();
  const mn=(id,t)=>{ if(!nm.has(id))nm.set(id,new Set()); nm.get(id).add(t); };
  const me=(s,tg,t)=>{ const k=`${s}->${tg}`; if(!em.has(k))em.set(k,new Set()); em.get(k).add(t); };
  for(const p of(fraud.circular?.fraudPaths??[])) for(const s of p){mn(s.from,"circular");mn(s.to,"circular");me(s.from,s.to,"circular");}
  for(const t of(fraud.highValue?.transactions??[])){mn(t.from,"high_value");mn(t.to,"high_value");me(t.from,t.to,"high_value");}
  for(const a of(fraud.fanOut?.accounts??[])) for(const tgt of(a.sentTo??[])){mn(a.account,"fan_out");mn(tgt,"fan_out");me(a.account,tgt,"fan_out");}
  for(const a of(fraud.fanIn?.accounts??[])) for(const src of(a.receivedFrom??[])){mn(a.account,"fan_in");mn(src,"fan_in");me(src,a.account,"fan_in");}
  const nodeMap=new Map(); for(const n of graphData.nodes) if(!nodeMap.has(n.id))nodeMap.set(n.id,n);
  const nodes=new DataSet([...nodeMap.values()].map(n=>{
    const label=n.name??n.id, ts=nm.get(n.id)??new Set(), dt=domType(ts), f=dt?FC[dt]:null, nf=FC.normal;
    return { id:n.id, label, color:{background:f?f.nodeBg:nf.nodeBg, border:f?f.nodeBorder:nf.nodeBorder, highlight:{background:FC.selected.nodeBg,border:FC.selected.nodeBorder}, hover:{background:f?f.nodeBg:"#122040",border:f?f.nodeBorder:"#93c5fd"}}, font:{color:f?f.label:TEXT_COLOR}, borderWidth:dt?3.5:2, size:dt?26:20, shadow:{enabled:true,size:dt?24:14,x:0,y:dt?0:3,color:f?f.glow:"rgba(0,0,0,0.75)"}, title:tooltip(label,ts), _typeSet:ts, _domType:dt, _label:label };
  }));
  const edgeMap=new Map(); for(const e of graphData.links){const k=`${e.source}->${e.target}`;if(!edgeMap.has(k))edgeMap.set(k,e);}
  let eid=1;
  const edges=new DataSet([...edgeMap.values()].map(e=>{
    const k=`${e.source}->${e.target}`, ts=em.get(k)??new Set(), dt=domType(ts), f=dt?FC[dt]:null;
    return { id:eid++, from:e.source, to:e.target, label:e.amount!=null?`$${e.amount}`:undefined, color:{color:f?f.edge:EDGE_NORMAL,highlight:f?f.nodeBorder:"#60a5fa",hover:f?f.nodeBorder:"#60a5fa"}, width:dt?3.5:1.2, title:tooltip(`${e.source}→${e.target}`,ts,e.amount), _typeSet:ts, _domType:dt, _source:e.source, _target:e.target, _amount:e.amount };
  }));
  return {nodes,edges,nm,em};
}

function highlightNode(nodes,id){ const s=FC.selected; nodes.update({id,color:{background:s.nodeBg,border:s.nodeBorder,highlight:{background:s.nodeBg,border:s.nodeBorder}},font:{color:s.label},borderWidth:5,size:28,shadow:{enabled:true,size:28,x:0,y:0,color:s.glow}}); }
function unhighlightNode(nodes,id){ const n=nodes.get(id); if(!n)return; const f=n._domType?FC[n._domType]:null,nf=FC.normal; nodes.update({id,color:{background:f?f.nodeBg:nf.nodeBg,border:f?f.nodeBorder:nf.nodeBorder,highlight:{background:FC.selected.nodeBg,border:FC.selected.nodeBorder},hover:{background:f?f.nodeBg:"#122040",border:f?f.nodeBorder:"#93c5fd"}},font:{color:f?f.label:TEXT_COLOR},borderWidth:n._domType?3.5:2,size:n._domType?26:20,shadow:{enabled:true,size:n._domType?24:14,x:0,y:n._domType?0:3,color:f?f.glow:"rgba(0,0,0,0.75)"}}); }
function applyToggles(nodes,edges,active){ nodes.update(nodes.get().map(n=>({id:n.id,hidden:n._typeSet?.size>0&&![...n._typeSet].some(t=>active.has(t))}))); edges.update(edges.get().map(e=>({id:e.id,hidden:e._typeSet?.size>0&&![...e._typeSet].some(t=>active.has(t))}))); }

function useClock(){ const[t,st]=useState(()=>new Date().toLocaleTimeString("en-GB")); useEffect(()=>{const id=setInterval(()=>st(new Date().toLocaleTimeString("en-GB")),1000);return()=>clearInterval(id);},[]);return t; }
function useCountUp(target,dur=800){ const[v,sv]=useState(0); useEffect(()=>{ if(target==null)return; let s=null; const step=ts=>{if(!s)s=ts;const p=Math.min((ts-s)/dur,1);sv(Math.floor(target*p));if(p<1)requestAnimationFrame(step);else sv(target);}; requestAnimationFrame(step); },[target,dur]); return v; }

// ═════════════════════════════════════════════════════════════════════════════
export default function App() {
  const containerRef  = useRef(null);
  const networkRef    = useRef(null);
  const nodesRef      = useRef(null);
  const edgesRef      = useRef(null);
  const prevIdRef     = useRef(null);
  const searchRef     = useRef(null);

  const [status,       setStatus]      = useState("idle");
  const [error,        setError]       = useState(null);
  const [loadStep,     setLoadStep]    = useState(0);
  const [stats,        setStats]       = useState(null);
  const [fraudPaths,   setFraudPaths]  = useState([]);
  const [selected,     setSelected]    = useState(null);
  const [txnTab,       setTxnTab]      = useState("all");
  const [panelTab,     setPanelTab]    = useState("node");
  const [activeTypes,  setActiveTypes] = useState(new Set(ALL_TYPES));

  // Search
  const [searchQ,      setSearchQ]     = useState("");
  const [searchSt,     setSearchSt]    = useState("idle");
  const [suggestions,  setSuggestions] = useState([]);
  const [showSug,      setShowSug]     = useState(false);

  // Alerts
  const [alerts,       setAlerts]      = useState([]);
  const [alertsLoad,   setAlertsLoad]  = useState(false);
  const [showAlerts,   setShowAlerts]  = useState(false);

  // Simulate
  const [simRunning,   setSimRunning]  = useState(false);
  const [toast,        setToast]       = useState(null);

  // Explain
  const [explain,      setExplain]     = useState(null);  // { loading, data }

  // Detect
  const [detectForm,   setDetectForm]  = useState({ from:"", to:"", amount:"" });
  const [detecting,    setDetecting]   = useState(false);
  const [detectResult, setDetectResult]= useState(null);

  const clock = useClock();

  // ── toggle types ─────────────────────────────────────────────────────────────
  const toggleType = useCallback((t) => { setActiveTypes(prev=>{const next=new Set(prev);if(next.has(t))next.delete(t);else next.add(t);if(nodesRef.current&&edgesRef.current)applyToggles(nodesRef.current,edgesRef.current,next);return next;}); },[]);
  const toggleAll  = useCallback((on) => { const next=on?new Set(ALL_TYPES):new Set(); setActiveTypes(next); if(nodesRef.current&&edgesRef.current)applyToggles(nodesRef.current,edgesRef.current,next); },[]);

  // ── open node ─────────────────────────────────────────────────────────────────
  const openNode = useCallback((nodeId) => {
    const nodes=nodesRef.current, edges=edgesRef.current, net=networkRef.current;
    if(!nodes||!edges||!net)return;
    if(prevIdRef.current&&prevIdRef.current!==nodeId)unhighlightNode(nodes,prevIdRef.current);
    const node=nodes.get(nodeId); if(!node)return;
    highlightNode(nodes,nodeId); prevIdRef.current=nodeId;
    net.focus(nodeId,{scale:1.3,animation:{duration:600,easingFunction:"easeInOutCubic"}});
    const connIds=net.getConnectedEdges(nodeId);
    const incoming=[],outgoing=[];
    for(const eid of connIds){const e=edges.get(eid);if(!e)continue;(e._target===nodeId?incoming:outgoing).push(e);}
    setSelected({nodeId,label:node._label,domType:node._domType,typeSet:node._typeSet,incoming,outgoing});
    setTxnTab("all"); setPanelTab("node");

    // Fetch fraud explanation for this node
    setExplain({ loading: true, data: null });
    fetch(`${API_BASE}/explain/${encodeURIComponent(nodeId)}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(data => setExplain({ loading: false, data }))
      .catch(() => setExplain({ loading: false, data: null }));
  },[]);

  const clearNode = useCallback(() => {
    if(prevIdRef.current){unhighlightNode(nodesRef.current,prevIdRef.current);prevIdRef.current=null;}
    setSelected(null);
    setExplain(null);
  },[]);

  // ── search ────────────────────────────────────────────────────────────────────
  const onSearchChange = useCallback((e) => {
    const q=e.target.value; setSearchQ(q); setSearchSt("idle");
    if(!q.trim()||!nodesRef.current){setSuggestions([]);setShowSug(false);return;}
    const lo=q.toLowerCase(), hits=nodesRef.current.get().filter(n=>n.id.toLowerCase().includes(lo)||(n._label??"").toLowerCase().includes(lo)).slice(0,8);
    setSuggestions(hits); setShowSug(hits.length>0);
  },[]);

  const doSearch = useCallback((override) => {
    const q=(override??searchQ).trim(); if(!q||!nodesRef.current)return;
    setShowSug(false);
    const lo=q.toLowerCase(),all=nodesRef.current.get();
    const node=all.find(n=>n.id.toLowerCase()===lo)||all.find(n=>(n._label??"").toLowerCase()===lo)||all.find(n=>n.id.toLowerCase().includes(lo))||all.find(n=>(n._label??"").toLowerCase().includes(lo));
    if(!node){setSearchSt("not-found");const el=searchRef.current;if(el){el.classList.add("search-shake");setTimeout(()=>el.classList.remove("search-shake"),500);}return;}
    setSearchQ(node._label??node.id); setSearchSt("found"); openNode(node.id);
  },[searchQ,openNode]);

  const clearSearch = useCallback(() => { setSearchQ(""); setSearchSt("idle"); setSuggestions([]); setShowSug(false); clearNode(); searchRef.current?.focus(); },[clearNode]);

  // ── detect transaction ────────────────────────────────────────────────────────
  const handleDetect = useCallback(async (e) => {
    e.preventDefault();
    const { from, to, amount } = detectForm;
    if (!from.trim() || !to.trim() || !amount) return;
    setDetecting(true);
    setDetectResult(null);
    try {
      const res = await fetch(`${API_BASE}/detect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: from.trim(), to: to.trim(), amount: parseFloat(amount) }),
      });
      const data = await res.json();
      setDetectResult(data);
    } catch (err) {
      setDetectResult({ isFraud: null, reasons: [`Error: ${err.message}`], error: true });
    } finally {
      setDetecting(false);
    }
  }, [detectForm]);

  // ── alerts ────────────────────────────────────────────────────────────────────
  const loadAlerts = useCallback(async () => {
    setAlertsLoad(true);
    try {
      const res=await fetch(`${API_BASE}/alerts?minScore=60&limit=50`);
      if(!res.ok)throw new Error(`${res.status}`);
      const data=await res.json();
      setAlerts(data.alerts??[]);
    } catch(err){ console.warn("[alerts]",err.message); setAlerts([]); }
    finally { setAlertsLoad(false); }
  },[]);

  // ── simulate ──────────────────────────────────────────────────────────────────
  const showToast = (msg, type="ok", dur=3000) => { setToast({msg,type}); setTimeout(()=>setToast(null),dur); };

  const simulate = useCallback(async () => {
    if(simRunning||status!=="ready")return;
    setSimRunning(true);
    showToast("⚡ Simulating transactions…","ok",10000);
    try {
      const res=await fetch(`${API_BASE}/simulate`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({count:8})});
      if(!res.ok)throw new Error(`API returned ${res.status}`);
      const data=await res.json();
      showToast(`✓ ${data.created} transactions added — refreshing…`,"ok",2500);
      await new Promise(r=>setTimeout(r,800));
      // Reload graph without full reset
      const[gRes,fRes]=await Promise.all([fetch(`${API_BASE}/graph`),fetch(`${API_BASE}/fraud/all`)]);
      if(!gRes.ok||!fRes.ok)throw new Error("Refresh failed");
      const graphData=await gRes.json(), fraudData=await fRes.json();
      const fraud={circular:fraudData.circular,highValue:fraudData.highValue,fanOut:fraudData.fanOut,fanIn:fraudData.fanIn};
      const{nodes,edges,nm}=buildVisData(graphData,fraud);
      nodesRef.current=nodes; edgesRef.current=edges;
      applyToggles(nodes,edges,activeTypes);
      setFraudPaths(fraud.circular?.fraudPaths??[]);
      setStats(prev=>({...prev,totalNodes:nodes.length,totalEdges:edges.length,circular:fraud.circular?.count??0,highValue:fraud.highValue?.count??0,fanOut:fraud.fanOut?.count??0,fanIn:fraud.fanIn?.count??0,fraudNodes:nm.size}));
      if(networkRef.current){networkRef.current.setData({nodes,edges});}
      showToast(`✓ Graph updated — ${nodes.length} nodes, ${edges.length} edges`,"ok");
      loadAlerts();
    } catch(err){
      showToast(`✗ ${err.message}`,"error");
    } finally {
      setSimRunning(false);
    }
  },[simRunning,status,activeTypes,loadAlerts]);

  // ── load graph ────────────────────────────────────────────────────────────────
  const loadGraph = useCallback(async () => {
    setStatus("loading"); setError(null); clearNode(); setLoadStep(0);
    try {
      setLoadStep(1);
      const[gRes,fRes]=await Promise.all([fetch(`${API_BASE}/graph`),fetch(`${API_BASE}/fraud/all`)]);
      setLoadStep(2);
      if(!gRes.ok)throw new Error(`Graph API returned ${gRes.status}`);
      if(!fRes.ok)throw new Error(`Fraud API returned ${fRes.status}`);
      const graphData=await gRes.json(), fraudData=await fRes.json();
      setLoadStep(3);
      const fraud={circular:fraudData.circular,highValue:fraudData.highValue,fanOut:fraudData.fanOut,fanIn:fraudData.fanIn};
      setFraudPaths(fraud.circular?.fraudPaths??[]);
      const{nodes,edges,nm}=buildVisData(graphData,fraud);
      nodesRef.current=nodes; edgesRef.current=edges;
      applyToggles(nodes,edges,activeTypes);
      setStats({totalNodes:nodes.length,totalEdges:edges.length,fraudNodes:nm.size,circular:fraud.circular?.count??0,highValue:fraud.highValue?.count??0,fanOut:fraud.fanOut?.count??0,fanIn:fraud.fanIn?.count??0});
      if(!networkRef.current){
        const net=new Network(containerRef.current,{nodes,edges},VIS_OPTS);
        networkRef.current=net;
        net.on("click",p=>{if(!p.nodes.length){clearNode();return;}openNode(p.nodes[0]);});
        net.on("stabilizationIterationsDone",()=>{net.setOptions({physics:{enabled:false}});net.fit({animation:{duration:800,easingFunction:"easeOutQuart"}});});
      } else { networkRef.current.setData({nodes,edges}); }
      await new Promise(r=>setTimeout(r,300));
      setStatus("ready");
      loadAlerts();
    } catch(err){ setError(err.message); setStatus("error"); }
  },[openNode,clearNode,activeTypes,loadAlerts]); // eslint-disable-line

  useEffect(()=>{loadGraph();},[]);// eslint-disable-line

  // ── derived ───────────────────────────────────────────────────────────────────
  const txnList=selected?(txnTab==="in"?selected.incoming:txnTab==="out"?selected.outgoing:[...selected.incoming,...selected.outgoing]):[];
  const inTotal=selected?.incoming.reduce((s,e)=>s+(e._amount??0),0)??0;
  const outTotal=selected?.outgoing.reduce((s,e)=>s+(e._amount??0),0)??0;

  const STEPS=["Connecting to Neo4j","Fetching graph data","Running fraud detectors","Building visualization"];

  // ═══════════════════════════════════════════════════════════════════════════
  return (
    <div className="fds-root">

      {/* ══ TOP BAR ══ */}
      <header className="fds-topbar">
        {/* Row 1 */}
        <div className="fds-row1">
          <div className="fds-brand">
            <div className="fds-brand-icon">⬡</div>
            <div>
              <div className="fds-brand-title">FraudScope</div>
              <div className="fds-brand-sub">Neo4j · Graph Intelligence</div>
            </div>
          </div>
          <div className="fds-status-pill">
            <div className={`fds-dot ${status==="loading"?"amber":status==="error"?"red":""}`}/>
            {status==="loading"?"SYNCING":status==="error"?"OFFLINE":"LIVE"}
          </div>
          <div style={{flex:1}}/>
          <div className="fds-clock">{clock}</div>
          <div className="fds-actions">
            <button className="btn btn-ghost btn-sm" onClick={()=>networkRef.current?.fit({animation:true})}>⊡ Fit</button>
            <button className={`btn btn-ghost btn-sm${showAlerts?" btn-bell-active":""}`} onClick={()=>setShowAlerts(v=>!v)}>
              🔔{alerts.length>0?<span className="bell-badge">{alerts.length}</span>:null}
            </button>
            <button className={`btn btn-simulate btn-sm${simRunning?" running":""}`} onClick={simulate} disabled={simRunning||status!=="ready"}>
              {simRunning?"⟳ Running…":"⚡ Simulate"}
            </button>
            <button className="btn btn-primary btn-sm" onClick={loadGraph} disabled={status==="loading"}>
              {status==="loading"?"↻ …":"↻ Refresh"}
            </button>
          </div>
        </div>
        {/* Row 2 */}
        <div className="fds-row2">
          <div className="fds-stats-row">
            <StatCard icon="⬡" label="Accounts"    value={stats?.totalNodes} color="blue"   delay={0.10}/>
            <StatCard icon="⇄" label="Transactions" value={stats?.totalEdges} color="teal"   delay={0.16}/>
            <StatCard icon="↺" label="Loops"        value={stats?.circular}   color="red"    delay={0.22}/>
            <StatCard icon="$" label="High-Val"     value={stats?.highValue}  color="orange" delay={0.28}/>
            <StatCard icon="↗" label="Fan-Out"      value={stats?.fanOut}     color="purple" delay={0.34}/>
            <StatCard icon="🔔" label="Alerts"      value={alerts.length}     color="red"    delay={0.40}/>
          </div>
          {/* Search */}
          <div className="fds-search-wrap">
            <div className={`fds-search-box${searchSt!=="idle"?` fds-search-${searchSt}`:""}`}>
              <span className={`fds-search-icon${searchSt==="found"?" found":searchSt==="not-found"?" nf":""}`}>
                {searchSt==="found"?"✓":searchSt==="not-found"?"✗":"⌕"}
              </span>
              <input ref={searchRef} className="fds-search-input" type="text" placeholder="Search account ID or name…"
                value={searchQ} onChange={onSearchChange} onBlur={()=>setTimeout(()=>setShowSug(false),150)}
                onKeyDown={e=>{if(e.key==="Enter")doSearch();if(e.key==="Escape")clearSearch();}}
                disabled={status!=="ready"} autoComplete="off" spellCheck="false"/>
              {searchQ&&<button className="fds-search-clear" onClick={clearSearch} tabIndex={-1}>×</button>}
              <button className="fds-search-btn" onClick={()=>doSearch()} disabled={status!=="ready"||!searchQ.trim()}>→</button>
            </div>
            {searchSt==="not-found"&&<div className="fds-search-fb nf">No match for "{searchQ}"</div>}
            {searchSt==="found"&&searchQ&&<div className="fds-search-fb found">✓ Jumped to {searchQ}</div>}
            {showSug&&suggestions.length>0&&(
              <div className="fds-search-drop">
                {suggestions.map(n=>{const f=n._domType?FC[n._domType]:null;return(
                  <div key={n.id} className="fds-sug-row" onMouseDown={()=>{setSearchQ(n._label??n.id);setSuggestions([]);setShowSug(false);setSearchSt("found");openNode(n.id);}}>
                    <div className="fds-sug-dot" style={{background:f?f.nodeBorder:FC.normal.nodeBorder}}/>
                    <div className="fds-sug-text"><span className="fds-sug-name">{n._label??n.id}</span><span className="fds-sug-id">{n.id}</span></div>
                    {f&&<span className="fds-sug-badge" style={{color:f.label,borderColor:f.nodeBorder,background:f.nodeBg}}>{f.icon} {f.name}</span>}
                  </div>
                );})}
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="fds-workspace">

        {/* ══ GRAPH ══ */}
        <div className="fds-graph-area">
          {status==="loading"&&(
            <div className="fds-overlay">
              <div className="fds-spinner-wrap"><div className="fds-spin-core"/><div className="fds-spin-r r1"/><div className="fds-spin-r r2"/></div>
              <div className="fds-ol-title">Analyzing transaction graph</div>
              <div className="fds-ol-sub">Connecting to Neo4j · Running fraud detectors</div>
              <div className="fds-bar-wrap"><div className="fds-bar"/></div>
              <div className="fds-steps">{STEPS.map((s,i)=>(
                <div key={i} className={`fds-step${i<loadStep?" done":i===loadStep?" active":""}`}>
                  <div className="fds-step-dot"/>{i<loadStep?"✓ ":""}{s}
                </div>
              ))}</div>
            </div>
          )}
          {status==="error"&&(
            <div className="fds-overlay">
              <div className="fds-err-icon">⚠</div>
              <div className="fds-err-title">Connection Failed</div>
              <div className="fds-err-msg">{error}</div>
              <div className="fds-err-hint">Backend must be running on port 5000</div>
              <div className="fds-err-checks">
                <div className="fds-err-check">Run: node server.js</div>
                <div className="fds-err-check">Neo4j RUNNING in Desktop</div>
                <div className="fds-err-check">NEO4J_PASS correct in .env</div>
              </div>
              <button className="btn btn-primary" onClick={loadGraph}>↻ Retry</button>
            </div>
          )}
          <div ref={containerRef} className="fds-canvas"/>
          {status==="ready"&&(stats?.circular??0)>0&&(
            <div className="fds-fraud-banner"><div className="fds-banner-dot"/>{stats.circular} circular fraud loop{stats.circular>1?"s":""} detected</div>
          )}
          {status==="ready"&&!selected&&<div className="fds-hint">👆 Click any node to inspect transactions</div>}
          <div className="fds-zoom-btns">
            {[{l:"+",a:()=>{const n=networkRef.current;if(n)n.moveTo({scale:n.getScale()*1.25,animation:true});}},{l:"−",a:()=>{const n=networkRef.current;if(n)n.moveTo({scale:n.getScale()*0.8,animation:true});}},{l:"⊡",a:()=>networkRef.current?.fit({animation:true})}].map(({l,a})=>(
              <button key={l} className="fds-zoom-btn" onClick={a}>{l}</button>
            ))}
          </div>
          <div className="fds-toggles">
            <span className="fds-tog-lbl">SHOW:</span>
            {ALL_TYPES.map(type=>{const f=FC[type];const on=activeTypes.has(type);return(
              <button key={type} className={`fds-tog${on?" on":" off"}`}
                style={{"--tc":f.nodeBorder,"--tg":f.glow,"--tbg":on?`${f.nodeBg}cc`:"rgba(6,12,26,0.7)","--tbd":on?f.nodeBorder:"#1a2848","--ttx":on?f.label:"#2d4070"}}
                onClick={()=>toggleType(type)}>
                <span className="fds-tog-dot" style={{background:on?f.nodeBorder:"#1a2848"}}/>{f.icon} {f.name}
              </button>
            );})}
            <button className="fds-tog off" style={{"--tc":"#3b82f6","--tg":"rgba(59,130,246,0.2)","--tbg":"rgba(6,12,26,0.7)","--tbd":"#1a2848","--ttx":"#3d5478"}}
              onClick={()=>toggleAll(activeTypes.size<ALL_TYPES.length)}>
              {activeTypes.size<ALL_TYPES.length?"Show All":"Hide All"}
            </button>
          </div>
        </div>

        {/* ══ RIGHT PANEL ══ */}
        <aside className="fds-panel">
          <div className="fds-panel-tabs">
            <button className={`fds-tab${panelTab==="node"?" active":""}`} onClick={()=>setPanelTab("node")}>
              {selected?`⬡ ${selected.label}`:"Node Detail"}
            </button>
            <button className={`fds-tab${panelTab==="cycles"?" active red-tab":""}`} onClick={()=>setPanelTab("cycles")}>
              ⚠ Fraud Cycles{fraudPaths.length>0&&<span className="fds-tab-ct">{fraudPaths.length}</span>}
            </button>
            <button className={`fds-tab${panelTab==="detect"?" active teal-tab":""}`} onClick={()=>setPanelTab("detect")}>
              ⚡ Detect
            </button>
          </div>
          <div className="fds-panel-body">
            {panelTab==="node"&&(
              selected?(
                <>
                  <div className="fds-node-card" style={selected.domType?{borderColor:`${FC[selected.domType].nodeBorder}44`,background:`${FC[selected.domType].nodeBg}66`,boxShadow:`0 0 20px ${FC[selected.domType].glow}`}:{}}>
                    <div className="fds-node-hd">
                      <div className="fds-node-av" style={selected.domType?{background:FC[selected.domType].nodeBg,borderColor:FC[selected.domType].nodeBorder,color:FC[selected.domType].label,boxShadow:`0 0 18px ${FC[selected.domType].glow}`}:{background:FC.normal.nodeBg,borderColor:FC.normal.nodeBorder,color:TEXT_COLOR}}>
                        {(selected.label?.[0]??"?").toUpperCase()}
                      </div>
                      <div style={{flex:1,minWidth:0}}>
                        <div className="fds-node-name">{selected.label}</div>
                        <div className="fds-node-id">ID: {selected.nodeId}</div>
                        <div style={{display:"flex",gap:4,flexWrap:"wrap",marginTop:7}}>
                          {[...(selected.typeSet??[])].map(t=>{const f=FC[t];return(<span key={t} style={{background:f.nodeBg,border:`1px solid ${f.nodeBorder}`,borderRadius:5,padding:"2px 8px",fontSize:9,fontWeight:700,color:f.label,letterSpacing:".06em",fontFamily:"var(--font-mono)"}}>{f.icon} {f.name.toUpperCase()}</span>);})}
                        </div>
                      </div>
                      <button className="btn btn-ghost" style={{padding:"5px 9px",fontSize:13,flexShrink:0}} onClick={clearNode}>✕</button>
                    </div>
                    <div className="fds-flow-grid">
                      <div className="fds-flow-cell"><div className="fds-flow-ico">↙</div><div className="fds-flow-val green">${inTotal.toLocaleString()}</div><div className="fds-flow-lbl">Received</div><div className="fds-flow-ct">{selected.incoming.length} txns</div></div>
                      <div className="fds-flow-cell"><div className="fds-flow-ico">↗</div><div className="fds-flow-val blue">${outTotal.toLocaleString()}</div><div className="fds-flow-lbl">Sent</div><div className="fds-flow-ct">{selected.outgoing.length} txns</div></div>
                    </div>
                  </div>

                  {/* ── FRAUD EXPLANATION — always visible, above transactions ── */}
                  <ExplainSection explain={explain} />

                  <div className="fds-sec-hd"><span className="fds-sec-title">Transactions</span><span className={`fds-sec-badge${selected.domType==="circular"?" red":" blue"}`}>{selected.incoming.length+selected.outgoing.length} total</span></div>
                  <div className="fds-txn-tabs">
                    {[{k:"all",l:`All (${selected.incoming.length+selected.outgoing.length})`},{k:"in",l:`In (${selected.incoming.length})`},{k:"out",l:`Out (${selected.outgoing.length})`}].map(({k,l})=>(
                      <button key={k} className={`fds-txn-tab${txnTab===k?" active":""}`} onClick={()=>setTxnTab(k)}>{l}</button>
                    ))}
                  </div>
                  <div className="fds-txn-list">
                    {txnList.length===0?(<div className="fds-empty"><div className="fds-empty-icon">⇄</div><div className="fds-empty-title">No transactions</div></div>)
                    :txnList.map((t,i)=>{const isIn=t._target===selected.nodeId;const ef=t._domType?FC[t._domType]:null;return(
                      <div key={i} className="fds-txn-item" style={{animationDelay:`${i*.04}s`,...(ef?{borderColor:`${ef.nodeBorder}44`,background:`${ef.nodeBg}55`}:{})}}>
                        <div className="fds-txn-top">
                          <div className={`fds-dir-badge${isIn?" in":" out"}`}>{isIn?"↙ IN":"↗ OUT"}</div>
                          {t._amount!=null&&<div className={`fds-txn-amt${isIn?" in":" out"}`}>{isIn?"+":"−"}${t._amount.toLocaleString()}</div>}
                          {t._domType&&ef&&<div className="fds-txn-pill" style={{background:ef.nodeBg,borderColor:ef.nodeBorder,color:ef.label}}>{ef.icon} {ef.name.toUpperCase()}</div>}
                        </div>
                        <div className="fds-txn-flow">
                          <span className={`fds-txn-peer${t._source===selected.nodeId?" hi":""}`}>{t._source}</span>
                          <span className="fds-txn-arr">──▶</span>
                          <span className={`fds-txn-peer${t._target===selected.nodeId?" hi":""}`}>{t._target}</span>
                        </div>
                      </div>
                    );})}
                  </div>
                </>
              ):(
                <div className="fds-empty"><div className="fds-empty-icon">⬡</div><div className="fds-empty-title">No node selected</div><div className="fds-empty-sub">Click any account node in the graph to view its transaction history and connections.</div></div>
              )
            )}
            {panelTab==="cycles"&&(
              <>
                <div className="fds-sec-hd" style={{marginBottom:14}}><span className="fds-sec-title">Detected Fraud Loops</span><span className="fds-sec-badge red">{fraudPaths.length} loop{fraudPaths.length!==1?"s":""}</span></div>
                {fraudPaths.length===0?(<div className="fds-empty"><div className="fds-empty-icon">✓</div><div className="fds-empty-title">No circular fraud</div><div className="fds-empty-sub">No circular patterns found.</div></div>)
                :(fraudPaths.map((path,i)=>(
                  <div key={i} className="fds-cycle-card" style={{animationDelay:`${i*.06}s`}}>
                    <div className="fds-cycle-hd"><span className="fds-cycle-lbl">⚠ Loop {i+1}</span><span className="fds-cycle-len">{path.length} hops</span></div>
                    <div className="fds-cycle-path">
                      {path.map((step,j)=>(<span key={j} style={{display:"contents"}}><span className="fds-cycle-node" onClick={()=>{openNode(step.from);setPanelTab("node");}}>{step.from}</span><span className="fds-cycle-arr">→</span>{j===path.length-1&&<span className="fds-cycle-node" onClick={()=>{openNode(step.to);setPanelTab("node");}}>{step.to}</span>}</span>))}
                    </div>
                  </div>
                )))}
              </>
            )}

            {/* ══ DETECT TAB ══ */}
            {panelTab==="detect"&&(
              <div className="fds-detect-tab">
                <div className="fds-sec-hd" style={{marginBottom:14}}>
                  <span className="fds-sec-title">⚡ Check Transaction</span>
                  <span className="fds-sec-badge" style={{background:"rgba(20,184,166,.12)",color:"#2dd4bf",borderColor:"rgba(20,184,166,.3)",border:"1px solid"}}>Real-time</span>
                </div>

                <form className="fds-detect-form" onSubmit={handleDetect}>
                  <div className="fds-detect-field">
                    <label className="fds-detect-label">From Account</label>
                    <input className="fds-detect-input" type="text" placeholder="e.g. ACC001"
                      value={detectForm.from} onChange={e=>setDetectForm(f=>({...f,from:e.target.value}))} required/>
                  </div>
                  <div className="fds-detect-field">
                    <label className="fds-detect-label">To Account</label>
                    <input className="fds-detect-input" type="text" placeholder="e.g. ACC002"
                      value={detectForm.to} onChange={e=>setDetectForm(f=>({...f,to:e.target.value}))} required/>
                  </div>
                  <div className="fds-detect-field">
                    <label className="fds-detect-label">Amount ($)</label>
                    <input className="fds-detect-input" type="number" placeholder="e.g. 75000"
                      value={detectForm.amount} onChange={e=>setDetectForm(f=>({...f,amount:e.target.value}))} min="0" required/>
                  </div>
                  <button type="submit" className={`fds-detect-btn${detecting?" loading":""}`} disabled={detecting}>
                    {detecting ? "⟳ Checking…" : "Check Fraud"}
                  </button>
                </form>

                {detectResult && (
                  <div className="fds-detect-result">
                    {/* Banner */}
                    <div className={`fds-detect-banner${detectResult.error?" error":detectResult.isFraud?" fraud":" safe"}`}>
                      {detectResult.error ? "⚠ Error" : detectResult.isFraud ? "⚠ FRAUD DETECTED" : "✅ SAFE TRANSACTION"}
                    </div>
                    {/* Reasons */}
                    <ul className="fds-detect-reasons">
                      {(detectResult.reasons??[]).map((r,i)=>(
                        <li key={i} className={`fds-detect-reason${detectResult.isFraud?" fraud":" safe"}`}>
                          <span>{detectResult.isFraud?"⚠":"✓"}</span>{r}
                        </li>
                      ))}
                    </ul>
                    {/* Meta row */}
                    {detectResult.details && (
                      <div className="fds-detect-meta">
                        <span>{detectResult.details.from} ──▶ {detectResult.details.to}</span>
                        <span>${Number(detectResult.details.amount).toLocaleString()}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          {/* Legend */}
          <div className="fds-legend">
            <div className="fds-leg"><div className="fds-leg-dot" style={{background:FC.normal.nodeBg,borderColor:FC.normal.nodeBorder}}/>Normal</div>
            {ALL_TYPES.map(type=>{const f=FC[type];const on=activeTypes.has(type);return(<div key={type} className="fds-leg" style={{opacity:on?1:.3,cursor:"pointer"}} onClick={()=>toggleType(type)}><div className="fds-leg-dot" style={{background:f.nodeBg,borderColor:f.nodeBorder,...(on?{boxShadow:`0 0 6px ${f.glow}`}:{})}}/>{f.icon} {f.name}</div>);})}
            <div className="fds-leg"><div className="fds-leg-dot" style={{background:FC.selected.nodeBg,borderColor:FC.selected.nodeBorder}}/>Selected</div>
            <div className="fds-leg"><div className="fds-leg-line" style={{background:EDGE_NORMAL}}/>Normal Txn</div>
            {ALL_TYPES.map(type=>{const f=FC[type];return(<div key={`el-${type}`} className="fds-leg" style={{opacity:activeTypes.has(type)?1:.3}}><div className="fds-leg-line" style={{background:f.edge}}/>{f.name} Txn</div>);})}
          </div>
        </aside>
      </div>

      {/* ══ ALERTS PANEL — floating overlay ══ */}
      {showAlerts&&(
        <div className="fds-alerts-overlay">
          <div className="fds-alerts-panel">
            {/* Header */}
            <div className="fds-alerts-hd">
              <div className="fds-alerts-title">
                <span>🔔</span> Risk Alerts
                {alerts.length>0&&<span className="fds-alerts-ct">{alerts.length}</span>}
              </div>
              <div style={{display:"flex",gap:6}}>
                <button className="btn btn-ghost btn-sm" onClick={loadAlerts} title="Refresh">↻</button>
                <button className="fds-alerts-x" onClick={()=>setShowAlerts(false)}>✕</button>
              </div>
            </div>
            <div className="fds-alerts-sub">Accounts with risk score &gt; 60 · Click to highlight</div>
            {/* Body */}
            <div className="fds-alerts-body">
              {alertsLoad?(
                <div className="fds-alerts-loading"><div className="fds-al-spin"/>Computing risk scores…</div>
              ):alerts.length===0?(
                <div className="fds-empty" style={{padding:"32px 16px"}}><div className="fds-empty-icon">✓</div><div className="fds-empty-title">No high-risk accounts</div><div className="fds-empty-sub">No accounts exceed risk threshold of 60.</div></div>
              ):(alerts.map((alert,i)=>{
                const rc=RC[alert.riskLevel]??RC.MEDIUM;
                const isActive=selected?.nodeId===alert.accountId;
                // circumference of circle r=20: 2π×20 ≈ 125.7
                const circ=125.7;
                const dash=(alert.riskScore/100)*circ;
                return(
                  <div key={alert.accountId} className={`fds-alert-card${isActive?" fds-alert-active":""}`}
                    style={{animationDelay:`${i*.04}s`,...(isActive?{borderColor:rc.border,boxShadow:`0 0 16px ${rc.bar}44`}:{})}}
                    onClick={()=>openNode(alert.accountId)}>
                    {/* Row 1: ring + info + badge */}
                    <div className="fds-alert-row1">
                      {/* Score ring */}
                      <svg width="52" height="52" viewBox="0 0 52 52" className="fds-score-ring" style={{flexShrink:0}}>
                        <circle cx="26" cy="26" r="20" fill="none" stroke="#162844" strokeWidth="3.5"/>
                        <circle cx="26" cy="26" r="20" fill="none" stroke={rc.bar} strokeWidth="3.5"
                          strokeDasharray={`${dash} ${circ}`}
                          strokeLinecap="round"
                          transform="rotate(-90 26 26)"
                          style={{filter:`drop-shadow(0 0 4px ${rc.bar})`}}/>
                        <text x="26" y="30" textAnchor="middle" fontSize="12" fontWeight="700"
                          fill={rc.text} fontFamily="Outfit,sans-serif">{alert.riskScore}</text>
                      </svg>
                      {/* Info */}
                      <div className="fds-alert-info">
                        <div className="fds-alert-name">{alert.name}</div>
                        <div className="fds-alert-id">{alert.accountId}</div>
                        <div className="fds-alert-reason">{alert.topReason}</div>
                      </div>
                      {/* Level badge */}
                      <div className="fds-alert-badge" style={{background:rc.bg,borderColor:rc.border,color:rc.text}}>{alert.riskLevel}</div>
                    </div>
                    {/* Risk bar */}
                    <div className="fds-alert-bar-wrap">
                      <div className="fds-alert-bar" style={{width:`${alert.riskScore}%`,background:rc.bar,boxShadow:`0 0 5px ${rc.bar}88`}}/>
                    </div>
                    {/* Signal chips */}
                    {alert.signals&&(
                      <div className="fds-alert-sigs">
                        {Object.entries(alert.signals).filter(([,v])=>v>0).map(([k,v])=>(
                          <span key={k} className="fds-sig-chip">{SIG_LABELS[k]??k} <strong>+{v}</strong></span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              }))}
            </div>
          </div>
        </div>
      )}

      {/* ══ TOAST ══ */}
      {toast&&(
        <div className={`fds-toast${toast.type==="error"?" err":""}`}>
          <div className="fds-toast-dot"/>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// ─── StatCard ─────────────────────────────────────────────────────────────────
function StatCard({icon,label,value,color,delay}){
  const v=useCountUp(value??0,900);
  return(
    <div className="fds-hstat" style={{animationDelay:`${delay}s`}}>
      <div className={`fds-hstat-icon ${color}`}>{icon}</div>
      <div className="fds-hstat-info">
        <div className={`fds-hstat-val ${color}${value==null?" loading":""}`}>{value==null?"—":v}</div>
        <div className="fds-hstat-label">{label}</div>
      </div>
    </div>
  );
}

// ─── ExplainSection ──────────────────────────────────────────────────────────
const SEVERITY_COLORS = {
  critical: { bg: "rgba(63,0,0,0.55)",   border: "#ef4444", text: "#fca5a5", dot: "#ef4444" },
  high:     { bg: "rgba(58,16,5,0.55)",  border: "#f97316", text: "#fed7aa", dot: "#f97316" },
  medium:   { bg: "rgba(42,26,0,0.55)",  border: "#f59e0b", text: "#fef3c7", dot: "#f59e0b" },
  low:      { bg: "rgba(12,42,26,0.55)", border: "#22c55e", text: "#bbf7d0", dot: "#22c55e" },
};
const TYPE_COLORS = {
  circular:   "#ef4444",
  fan_out:    "#a855f7",
  fan_in:     "#22c55e",
  high_value: "#f97316",
};

function ExplainSection({ explain }) {
  const [open, setOpen] = useState(true);

  // Always show — even while loading or on error
  if (!explain) return null;

  // ── Loading skeleton ───────────────────────────────────────────────────────
  if (explain.loading) {
    return (
      <div className="fds-explain-wrap">
        <div className="fds-explain-hd">
          <span className="fds-explain-hd-title">⚠ Why Flagged</span>
          <div className="fds-explain-spinner" />
        </div>
        <div className="fds-explain-skeleton">
          <div className="fds-skel-line wide" />
          <div className="fds-skel-line mid"  />
          <div className="fds-skel-line narrow"/>
        </div>
      </div>
    );
  }

  // ── Error / no data ────────────────────────────────────────────────────────
  if (!explain.data) {
    return (
      <div className="fds-explain-wrap">
        <div className="fds-explain-hd">
          <span className="fds-explain-hd-title">⚠ Why Flagged</span>
          <span className="fds-explain-hd-badge err">unavailable</span>
        </div>
        <div className="fds-explain-err">
          Could not load explanation. Check that the backend is running and the /api/explain endpoint is mounted.
        </div>
      </div>
    );
  }

  const d = explain.data;
  const hasFraud = d.reasons && d.reasons.length > 0;

  return (
    <div className="fds-explain-wrap">
      {/* Collapsible header */}
      <button className="fds-explain-hd" onClick={() => setOpen(v => !v)}>
        <span className="fds-explain-hd-title">
          {hasFraud ? "⚠ Why Flagged" : "✓ Analysis"}
        </span>
        <span className={`fds-explain-hd-badge ${hasFraud ? "red" : "green"}`}>
          {d.severity} · {d.reasons?.length ?? 0} reason{(d.reasons?.length ?? 0) !== 1 ? "s" : ""}
        </span>
        <span className="fds-explain-chevron">{open ? "▲" : "▼"}</span>
      </button>

      {/* Collapsible body */}
      {open && (
        <div className="fds-explain-body">
          {/* Summary */}
          <div className="fds-explain-summary">{d.summary}</div>

          {hasFraud ? (
            <div className="fds-explain-list">
              {d.reasons.map((r, i) => {
                const sc = SEVERITY_COLORS[r.severity] ?? SEVERITY_COLORS.low;
                const tc = TYPE_COLORS[r.type] ?? "#3b82f6";
                return (
                  <div
                    key={i}
                    className="fds-reason-card"
                    style={{ background: sc.bg, borderColor: sc.border, animationDelay: `${i * 0.07}s` }}
                  >
                    <div className="fds-reason-bar" style={{ background: tc }} />
                    <div className="fds-reason-body">
                      <div className="fds-reason-title-row">
                        <span className="fds-reason-icon" style={{ color: tc }}>{r.icon}</span>
                        <span className="fds-reason-title" style={{ color: sc.text }}>{r.title}</span>
                        <span className="fds-reason-sev" style={{ color: sc.dot }}>
                          {r.severity.toUpperCase()}
                        </span>
                      </div>
                      <p className="fds-reason-detail">{r.detail}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="fds-explain-clean">
              <span className="fds-explain-clean-icon">✓</span>
              No suspicious patterns detected for this account.
            </div>
          )}
        </div>
      )}
    </div>
  );
}