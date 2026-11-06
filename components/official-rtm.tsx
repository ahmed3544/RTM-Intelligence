"use client";

import { useMemo, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Clock3, Users } from "lucide-react";

type DataRow = Record<string, string | number | boolean | null>;
type DataSet = { id: string; name: string; sheet: string; rows: DataRow[]; columns: string[] };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const col = (rows: DataRow[], patterns: RegExp[]) => {
  const keys = rows[0] ? Object.keys(rows[0]) : [];
  return keys.find(k => patterns.some(p => p.test(norm(k)))) ?? null;
};
const num = (v: unknown): number => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.replace(/[, %$]/g, ""));
    if (Number.isFinite(n)) return n;
    const p = v.trim().split(":").map(Number);
    if (p.length === 3 && p.every(Number.isFinite)) return p[0] * 3600 + p[1] * 60 + p[2];
    if (p.length === 2 && p.every(Number.isFinite)) return p[0] * 60 + p[1];
  }
  return 0;
};
const fmt = (v: number | null, unit = "") => v === null || !Number.isFinite(v) ? "N/A" : `${v.toLocaleString(undefined,{maximumFractionDigits:2})}${unit}`;
const dur = (v: number | null) => {
  if (v === null || !Number.isFinite(v)) return "N/A";
  const s = Math.round(v);
  return `${Math.floor(s/3600)}:${String(Math.floor(s%3600/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;
};

export default function OfficialRtm({ datasets }: { datasets: DataSet[] }) {
  const [slaThreshold, setSlaThreshold] = useState(20);
  const [shortThreshold, setShortThreshold] = useState(10);
  const sources = useMemo(() => {
    const cdr = datasets.find(d => d.rows[0] && ("laststatus" in Object.fromEntries(Object.keys(d.rows[0]).map(k=>[norm(k),true])) || col(d.rows,[/^(laststatus|status)$/])));
    const login = datasets.find(d => d.rows[0] && col(d.rows,[/totallogintime/,/loginseconds/,/^logintime$/]));
    const pause = datasets.find(d => d.rows[0] && col(d.rows,[/totalpausetime/,/pausetime/]));
    return { cdr, login, pause };
  }, [datasets]);

  const result = useMemo(() => {
    const cdrRows = sources.cdr?.rows ?? [];
    const loginRows = sources.login?.rows ?? [];
    const pauseRows = sources.pause?.rows ?? [];
    if (!cdrRows.length) return null;
    const statusCol = col(cdrRows,[/^laststatus$/,/^callstatus$/,/^status$/]);
    const handlingCol = col(cdrRows,[/^handlingduration$/,/^talktime$/,/^duration$/]);
    const routingCol = col(cdrRows,[/^routingduration$/,/^waittime$/]);
    const idCol = col(cdrRows,[/^id$/,/^cdrid$/]);
    const holdCol = col(cdrRows,[/^holdtime$/,/^holdduration$/]);
    const rtqCol = col(cdrRows,[/^rtqcalls?$/,/^rtq$/]);
    const fromCol = col(cdrRows,[/^callfrom$/,/^caller$/,/^agent$/]);
    const seen = new Set<string>();
    let duplicates = 0, answered = 0, abandoned = 0, failed = 0, talk = 0, hold = 0, waiting = 0, sla = 0, short = 0, rtqCalls = 0;
    const agentMap = new Map<string,{agent:string;offered:number;answered:number;tht:number}>();
    for (const r of cdrRows) {
      const id = idCol ? String(r[idCol] ?? "").trim() : "";
      if (id && seen.has(id)) { duplicates++; continue; }
      if (id) seen.add(id);
      const status = String(statusCol ? r[statusCol] : "").trim().toUpperCase();
      const isAns = status === "ANSWERED" || status === "ANSWER";
      const isAbn = status === "ABANDONED" || status === "ABANDON";
      const isFail = ["FAILED","TERMINATED","TERMINATE","NO ANSWER","BUSY","CANCELLED","REJECTED"].includes(status);
      if (!isAns && !isAbn && !isFail) continue;
      if (rtqCol && (num(r[rtqCol]) > 0 || String(r[rtqCol]).trim().toLowerCase() === "true")) rtqCalls++;
      const agentRaw = fromCol ? String(r[fromCol] ?? "Unassigned") : "All agents";
      const ext = /<([0-9]{3,6})>/.exec(agentRaw)?.[1] ?? "";
      const agent = agentRaw.replace(/<\d{3,6}>/,"").trim() || agentRaw;
      const key = ext || agent;
      const a = agentMap.get(key) ?? {agent: ext ? `${agent} (${ext})` : agent, offered:0, answered:0, tht:0};
      a.offered++;
      const h = handlingCol ? num(r[handlingCol]) : 0;
      const rt = routingCol ? num(r[routingCol]) : 0;
      if (isAns) {
        answered++; talk += h; hold += holdCol ? num(r[holdCol]) : 0; waiting += routingCol ? rt : 0;
        if (routingCol && rt <= slaThreshold) sla++;
        if (h < shortThreshold) short++;
        a.answered++; a.tht += h + (holdCol ? num(r[holdCol]) : 0);
      } else if (isAbn) abandoned++;
      else if (isFail) failed++;
      agentMap.set(key,a);
    }
    const loginCol = col(loginRows,[/totallogintime/,/loginseconds/,/^logintime$/]);
    const pauseTimeCol = col(pauseRows,[/totalpausetime/,/pausetime/]);
    const pauseReasonCol = col(pauseRows,[/pausereason/,/^reason$/]);
    const login = loginCol ? loginRows.reduce((s,r)=>s+num(r[loginCol]),0) : 0;
    let aux = 0, follow = 0;
    for (const r of pauseRows) {
      const sec = pauseTimeCol ? num(r[pauseTimeCol]) : 0;
      const reason = String(pauseReasonCol ? r[pauseReasonCol] : "").toLowerCase();
      if (/follow.?up|acw|after.?call/.test(reason)) follow += sec;
      else aux += sec;
    }
    const offered = answered + abandoned + failed;
    const tht = talk + hold + follow;
    const available = login > 0 ? Math.max(0,login-tht-aux) : null;
    const entries = [
      ["Offered Calls",offered,"count"],["Answered Calls",answered,"count"],["Abandoned Calls",abandoned,"count"],["Terminated Calls (Failed / No Answer / Busy)",failed,"count"],
      ["Abandonment Rate",offered ? abandoned/offered*100 : null,"%"],["RTQ",rtqCol && offered ? rtqCalls/offered*100 : null,"%"],
      ["Workload",offered && answered ? offered*(tht/answered)/60 : null,"min"],["THT",tht,"sec"],["AHT",answered ? tht/answered : null,"sec"],
      ["SLA",offered && routingCol ? sla/offered*100 : null,"%"],["PCA",offered ? answered/offered*100 : null,"%"],
      ["ASA",answered && routingCol ? waiting/answered : null,"sec"],["Short Calls",answered ? short/answered*100 : null,"%"],
      ["Aux Pause",pauseRows.length ? aux : null,"sec"],["Follow-up / ACW",pauseRows.length ? follow : null,"sec"],
      ["Login Time",loginRows.length && loginCol ? login : null,"sec"],["Available Time",available,"sec"],
      ["Occupancy",available !== null && tht+available>0 ? tht/(tht+available)*100 : null,"%"],
      ["Utilization",available !== null && login>0 ? (tht+available)/login*100 : null,"%"],
    ] as [string,number|null,string][];
    return {entries, agents:[...agentMap.values()].sort((a,b)=>b.offered-a.offered), offered, answered, abandoned, failed, duplicates, tht, login, aux, follow, rtqAvailable:!!rtqCol, cdrName:sources.cdr?.name, loginName:sources.login?.name, pauseName:sources.pause?.name, missing:{login:!loginCol,pause:!pauseTimeCol,routing:!routingCol}};
  }, [sources,slaThreshold,shortThreshold]);

  const cards = result?.entries ?? [];
  return <section className="panel">
    <div className="panel-heading"><div><h3>Official RTM KPI Engine</h3><p>Deterministic calculations from the three YASTER exports. Missing source data is shown as N/A.</p></div><span className="ai-pill"><Activity size={13}/> KPI ENGINE</span></div>
    <div className="settings-row"><div><b>SLA threshold (seconds)</b><small>Routing duration threshold</small></div><input aria-label="SLA threshold" type="number" min="1" value={slaThreshold} onChange={e=>setSlaThreshold(Math.max(1,Number(e.target.value)||1))} className="w-24 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm"/></div>
    <div className="settings-row"><div><b>Short-call threshold (seconds)</b><small>Answered calls below this duration</small></div><input aria-label="Short-call threshold" type="number" min="1" value={shortThreshold} onChange={e=>setShortThreshold(Math.max(1,Number(e.target.value)||1))} className="w-24 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm"/></div>
    {!result ? <div className="empty-state"><AlertTriangle size={30}/><b>CDR export not detected</b><span>Upload the YASTER CDR, Agent Login Activity, and Agent Pause Activity files in Data uploads.</span></div> : <>
      <div className="active-data"><CheckCircle2 size={16}/>CDR: {result.cdrName} · Login: {result.loginName ?? "Not uploaded"} · Pause: {result.pauseName ?? "Not uploaded"}</div>
      <div className="stats">{cards.map(([label,value,unit])=><article className="stat-card" key={label}><span>{label}</span><strong>{unit==="sec"?dur(value):fmt(value,unit==="%"?"%":unit==="min"?" min":"")}</strong><small>{value===null?"Required source field unavailable":"Calculated from uploaded YASTER rows"}</small></article>)}</div>
      <div className="settings-note"><AlertTriangle size={16}/>Duplicate CDR rows excluded: {result.duplicates}. {result.missing.routing?"Routing Duration is missing; SLA and ASA are N/A. ":""}{result.missing.login?"Login export or Total Login Time column is missing. ":""}{result.missing.pause?"Pause export or Total Pause Time column is missing. ":""}Review the source mappings before operational use.</div>
      <div className="panel-heading"><div><h3><Users size={17} className="inline mr-2"/>Agent performance</h3><p>Agent-level call volume and handling duration.</p></div></div>
      <div className="table-wrap"><table><thead><tr><th>Agent</th><th>Offered</th><th>Answered</th><th>THT</th><th>AHT</th></tr></thead><tbody>{result.agents.map(a=><tr key={a.agent}><td>{a.agent}</td><td>{a.offered}</td><td>{a.answered}</td><td>{dur(a.tht)}</td><td>{dur(a.answered ? a.tht/a.answered : null)}</td></tr>)}</tbody></table></div>
    </>}
  </section>;
}
