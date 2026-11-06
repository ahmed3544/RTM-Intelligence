"use client";

import { useMemo, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Users } from "lucide-react";
import { calculateRtmKpis, type NormalizedCall, type KpiId } from "../lib/rtm-kpi-engine";

type DataRow = Record<string, string | number | boolean | null>;
type DataSet = { id: string; name: string; sheet: string; rows: DataRow[]; columns: string[] };
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const findCol = (rows: DataRow[], patterns: RegExp[]) => {
  const keys = rows[0] ? Object.keys(rows[0]) : [];
  return keys.find(k => patterns.some(p => p.test(norm(k)))) ?? null;
};
const value = (r: DataRow, key: string | null) => key ? r[key] : null;
const duration = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v >= 0 && v < 1 ? v * 86400 : v >= 0 ? v : null;
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const p = s.split(":").map(Number);
  if (p.length === 3 && p.every(Number.isFinite)) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2 && p.every(Number.isFinite)) return p[0] * 60 + p[1];
  return null;
};
const dateValue = (v: unknown): string | null => {
  if (v instanceof Date && Number.isFinite(v.getTime())) return v.toISOString();
  if (typeof v === "number" && v > 20000 && v < 80000) return new Date(Date.UTC(1899,11,30) + v * 86400000).toISOString();
  if (typeof v === "string" && v.trim()) {
    const d = new Date(v);
    if (Number.isFinite(d.getTime())) return d.toISOString();
  }
  return null;
};
const fmt = (v: number | null, unit: string) => {
  if (v === null || !Number.isFinite(v)) return "N/A";
  if (unit === "seconds" || unit === "minutes") {
    const seconds = Math.round(unit === "minutes" ? v * 60 : v);
    return unit === "minutes" ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2,"0")}s` : `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds % 3600 / 60)).padStart(2,"0")}:${String(seconds % 60).padStart(2,"0")}`;
  }
  return unit === "percent" ? `${v.toFixed(2)}%` : Math.round(v).toLocaleString();
};
const labels: Record<KpiId, string> = {
  offeredCalls:"Offered Calls", answeredCalls:"Answered Calls", abandonmentRate:"Abandonment Rate", rtqRate:"RTQ %", workloadMinutes:"Workload",
  tht:"THT", aht:"AHT", ahlt:"AHLT", shortCallsRate:"Short Calls %", sla:"SLA", pca:"PCA", asa:"ASA",
  occupancy:"Occupancy", utilization:"Utilization", adherence:"Adherence", conformance:"Conformance", shrinkage:"Shrinkage / Absenteeism", lateMinutes:"Late Minutes"
};
export default function OfficialRtm({ datasets }: { datasets: DataSet[] }) {
  const [slaThreshold, setSlaThreshold] = useState(20);
  const [shortThreshold, setShortThreshold] = useState(10);
  const [targets, setTargets] = useState<Partial<Record<KpiId,{target:number;direction:"higher"|"lower"}>>>({});
  const result = useMemo(() => {
    const cdr = datasets.find(d => d.rows.length && findCol(d.rows,[/^laststatus$/,/^callstatus$/,/^status$/]));
    if (!cdr) return null;
    const rows = cdr.rows;
    const statusCol = findCol(rows,[/^laststatus$/,/^callstatus$/,/^status$/]);
    const idCol = findCol(rows,[/^cdrid$/,/^uniqueid$/,/^callid$/,/^id$/]);
    const dateCol = findCol(rows,[/^calldate$/,/^timestamp$/,/^starttime$/,/^startdate$/,/^date$/]);
    const talkCol = findCol(rows,[/^talktime$/,/^talkduration$/,/^handlingduration$/,/^duration$/,/^callduration$/]);
    const holdCol = findCol(rows,[/^holdtime$/,/^holdduration$/]);
    const acwCol = findCol(rows,[/^acwtime$/,/^aftercallwork$/,/^wrapuptime$/]);
    const waitCol = findCol(rows,[/^routingduration$/,/^waittime$/,/^queuetime$/,/^waitingtime$/]);
    const agentCol = findCol(rows,[/^agent$/,/^agentname$/,/^callfrom$/,/^extension$/]);
    const extCol = findCol(rows,[/^extension$/,/^agentextension$/,/^agentnumber$/]);
    const projectCol = findCol(rows,[/^project$/,/^campaign$/,/^queue$/,/^queuename$/]);
    const rtqCol = findCol(rows,[/^rtq$/,/^rtqcalls?$/]);
    const shortCol = findCol(rows,[/^shortcall$/,/^shortcalls$/]);
    const calls: NormalizedCall[] = [];
    const skippedDates = {count:0};
    for (let i=0;i<rows.length;i++) {
      const r=rows[i];
      const rawStatus=String(value(r,statusCol) ?? "").trim().toLowerCase();
      const timestamp=dateValue(value(r,dateCol));
      if (!timestamp) { skippedDates.count++; continue; }
      let status: NormalizedCall["status"]="unknown";
      if (/abandon/.test(rawStatus)) status="abandoned";
      else if (/terminat|failed|busy|cancel|reject|no answer|timeout/.test(rawStatus)) status="terminated";
      else if (/answer|connect|complete|handled/.test(rawStatus)) {
        const wait=duration(value(r,waitCol));
        status=wait!==null && wait<=slaThreshold ? "answered_within" : "answered_after";
      }
      const rawAgent=String(value(r,agentCol) ?? "").trim();
      const extension=String(value(r,extCol) ?? (/<(\d{3,8})>/.exec(rawAgent)?.[1] ?? "")).trim() || null;
      const agentName=rawAgent.replace(/<\d{3,8}>/,"").trim() || null;
      const rtqValue=value(r,rtqCol);
      const shortValue=value(r,shortCol);
      calls.push({
        id:String(value(r,idCol) ?? `row-${i}-${timestamp}`), timestamp, agentId:extension || agentName || "unassigned",
        agentName, extension, projectName:String(value(r,projectCol) ?? "Unassigned"),
        status, talkSeconds:duration(value(r,talkCol)), holdSeconds:duration(value(r,holdCol)),
        acwSeconds:duration(value(r,acwCol)), waitingSeconds:duration(value(r,waitCol)),
        rtq:rtqCol ? (rtqValue===true || /^(1|true|yes)$/i.test(String(rtqValue))) : null,
        shortCall:shortCol ? (shortValue===true || /^(1|true|yes)$/i.test(String(shortValue))) : (duration(value(r,talkCol))!==null ? duration(value(r,talkCol))! < shortThreshold : null)
      });
    }
    if (!calls.length) return {error:"No CDR rows with a recognizable date/time column were found.", cdrName:cdr.name, skipped:skippedDates.count};
    const stamps=calls.map(c=>Date.parse(c.timestamp)).filter(Number.isFinite);
    const from=new Date(Math.min(...stamps)); from.setUTCHours(0,0,0,0);
    const to=new Date(Math.max(...stamps)); to.setUTCHours(23,59,59,999);
    const engine=calculateRtmKpis({calls,work:[],from:from.toISOString(),to:to.toISOString(),period:"mtd",scope:"project",scopeName:"All projects",targets});
    return {engine,cdrName:cdr.name,skipped:skippedDates.count,sourceColumns:{statusCol,dateCol,talkCol,holdCol,acwCol,waitCol,idCol}};
  },[datasets,slaThreshold,shortThreshold,targets]);
  return <section className="panel">
    <div className="panel-heading"><div><h3>Official RTM KPI Engine</h3><p>Centralized formulas from the official 18-KPI standard. Durations are normalized to seconds; unavailable source fields remain N/A.</p></div><span className="ai-pill"><Activity size={13}/> KPI ENGINE</span></div>
    <div className="settings-row"><div><b>SLA threshold (seconds)</b><small>Used to classify answered-within-threshold calls</small></div><input aria-label="SLA threshold" type="number" min="1" value={slaThreshold} onChange={e=>setSlaThreshold(Math.max(1,Number(e.target.value)||1))} className="w-24 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm"/></div>
    <div className="settings-row"><div><b>Short-call threshold (seconds)</b><small>Used when the source has no Short Call flag</small></div><input aria-label="Short-call threshold" type="number" min="1" value={shortThreshold} onChange={e=>setShortThreshold(Math.max(1,Number(e.target.value)||1))} className="w-24 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm"/></div>
    {!result ? <div className="empty-state"><AlertTriangle size={30}/><b>CDR export not detected</b><span>Upload the YASTER CDR export first.</span></div> : "error" in result ? <div className="empty-state"><AlertTriangle size={30}/><b>Cannot calculate KPIs</b><span>{result.error}</span></div> : <>
      <div className="active-data"><CheckCircle2 size={16}/>CDR: {result.cdrName} · Rows without date skipped: {result.skipped}</div>
      <div className="stats">{result.engine.kpis.map(k=><article className="stat-card" key={k.id}><span>{labels[k.id]}</span><strong>{fmt(k.value,k.unit)}</strong><small>{k.value===null?k.warning:k.source}</small><small>Target: {k.target===null?"Not set":fmt(k.target,k.unit)} · Variance: {k.variance===null?"N/A":fmt(k.variance,k.unit)} · Achievement: {k.achievement===null?"N/A":fmt(k.achievement,"percent")}</small><details><summary>Formula & source</summary><p>{k.formula}</p><p>{k.source}</p></details><div className="flex gap-2 items-center mt-2"><input aria-label={`${labels[k.id]} target`} className="w-24 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs" type="number" placeholder="Target" value={targets[k.id]?.target ?? ""} onChange={e=>setTargets(prev=>({...prev,[k.id]:e.target.value===""?undefined:{target:Number(e.target.value),direction:prev[k.id]?.direction ?? "higher"}}))}/><select aria-label={`${labels[k.id]} target direction`} className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs" value={targets[k.id]?.direction ?? "higher"} onChange={e=>setTargets(prev=>({...prev,[k.id]:prev[k.id]?{...prev[k.id]!,direction:e.target.value as "higher"|"lower"}:undefined}))}><option value="higher">Higher is better</option><option value="lower">Lower is better</option></select></div></article>)}</div>
      <div className="settings-note"><AlertTriangle size={16}/>The uploaded CDR currently supplies call KPIs only. Login, pause, schedule and attendance exports are not yet mapped to work-time KPIs; these correctly remain N/A. {result.engine.warnings.length} validation warning(s). {result.skipped} rows were skipped because date/time was missing or invalid.</div>
      <div className="panel-heading"><div><h3><Users size={17} className="inline mr-2"/>Agent performance</h3><p>Ranked by offered calls; AHT is aggregated as total THT divided by answered calls.</p></div></div>
      <div className="table-wrap"><table><thead><tr><th>Agent</th><th>Extension</th><th>Offered</th><th>Answered</th><th>AHT</th></tr></thead><tbody>{result.engine.agentRanking.map(a=><tr key={a.id}><td>{a.name}</td><td>{a.extension ?? "N/A"}</td><td>{a.offered}</td><td>{a.answered}</td><td>{fmt(a.aht,"seconds")}</td></tr>)}</tbody></table></div>
    </>}
  </section>;
}
