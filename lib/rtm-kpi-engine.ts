/**
 * Central RTM KPI formula engine.
 * All durations are seconds internally. The engine accepts normalized source records;
 * source adapters must map raw YASTER columns without mutating imported rows.
 */
export type CallStatus = "answered_within" | "answered_after" | "abandoned" | "terminated" | "unknown";
export type ScopeLevel = "agent" | "team" | "project";
export type PeriodKind = "daily" | "weekly" | "monthly" | "mtd";

export interface NormalizedCall {
  id: string;
  timestamp: string;
  agentId?: string | null;
  agentName?: string | null;
  extension?: string | null;
  teamId?: string | null;
  teamName?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  status: CallStatus;
  talkSeconds?: number | null;
  holdSeconds?: number | null;
  acwSeconds?: number | null;
  waitingSeconds?: number | null;
  shortCall?: boolean | null;
  rtq?: boolean | null;
}
export interface NormalizedWorkRecord {
  id: string;
  timestamp: string;
  agentId?: string | null;
  agentName?: string | null;
  extension?: string | null;
  teamId?: string | null;
  teamName?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  staffSeconds?: number | null;
  productiveSeconds?: number | null;
  availableSeconds?: number | null;
  plannedSeconds?: number | null;
  outOfAdherenceSeconds?: number | null;
  actualLoggedInSeconds?: number | null;
  scheduledSeconds?: number | null;
  lostOrNonProductiveSeconds?: number | null;
  scheduledLogin?: string | null;
  actualLogin?: string | null;
  recordType?: "login" | "pause" | "schedule" | "adherence" | "attendance";
  pauseReason?: string | null;
}
export interface KpiTarget { target: number; direction?: "higher" | "lower"; }
export type KpiId =
  | "offeredCalls" | "answeredCalls" | "abandonmentRate" | "rtqRate" | "workloadMinutes"
  | "tht" | "aht" | "ahlt" | "shortCallsRate" | "sla" | "pca" | "asa"
  | "occupancy" | "utilization" | "adherence" | "conformance" | "shrinkage" | "lateMinutes";
export interface KpiValue {
  id: KpiId; label: string; value: number | null; unit: "calls" | "seconds" | "minutes" | "percent";
  formula: string; source: string; target: number | null; variance: number | null;
  achievement: number | null; warning?: string;
}
export interface EngineWarning { code: string; severity: "warning" | "error"; message: string; recordId?: string; }
export interface EngineResult {
  scope: ScopeLevel; scopeId: string; scopeName: string; period: PeriodKind;
  from: string; to: string; kpis: KpiValue[]; warnings: EngineWarning[];
  reconciliation: { answeredMatches: boolean | null; offeredMatches: boolean | null; thtMatches: boolean | null };
  agentRanking: Array<{ id: string; name: string; extension: string | null; offered: number; answered: number; aht: number | null }>;
}
export interface EngineInput {
  calls: NormalizedCall[];
  work: NormalizedWorkRecord[];
  from: string; to: string; period: PeriodKind;
  scope?: ScopeLevel; scopeId?: string; scopeName?: string;
  targets?: Partial<Record<KpiId, KpiTarget>>;
  toleranceSeconds?: number;
}
const validSeconds = (v: number | null | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const dateMs = (v: string | undefined | null): number | null => {
  if (!v) return null;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : null;
};
const within = (v: string, from: number, to: number) => {
  const n = dateMs(v);
  return n !== null && n >= from && n <= to;
};
const pct = (n: number, d: number) => d > 0 ? n / d * 100 : null;
const div = (n: number, d: number) => d > 0 ? n / d : null;
const sameScope = (r: {agentId?:string|null;teamId?:string|null;projectId?:string|null}, scope: ScopeLevel, id?: string) => {
  if (!id) return true;
  return scope === "agent" ? r.agentId === id : scope === "team" ? r.teamId === id : r.projectId === id;
};
const minsSinceMidnight = (s: string | null | undefined) => {
  if (!s) return null;
  const m = /^(\\d{1,2}):(\\d{2})(?::(\\d{2}))?$/.exec(s.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) / 1 + Number(m[3] ?? 0) / 60 : null;
};
const targetValue = (id: KpiId, value: number | null, targets?: Partial<Record<KpiId,KpiTarget>>) => {
  const t = targets?.[id];
  if (value === null || !t || t.target === 0) return { target: t?.target ?? null, variance: t ? value === null ? null : value - t.target : null, achievement: null };
  const direction = t.direction ?? "higher";
  return { target: t.target, variance: value - t.target, achievement: direction === "higher" ? value / t.target * 100 : t.target / Math.max(value, Number.EPSILON) * 100 };
};
export function calculateRtmKpis(input: EngineInput): EngineResult {
  const scope = input.scope ?? "project";
  const from = dateMs(input.from), to = dateMs(input.to);
  const warnings: EngineWarning[] = [];
  if (from === null || to === null || from > to) throw new Error("Invalid reporting period: provide valid ISO dates with from <= to.");
  const calls = input.calls.filter(r => within(r.timestamp, from, to) && sameScope(r,scope,input.scopeId));
  const work = input.work.filter(r => within(r.timestamp, from, to) && sameScope(r,scope,input.scopeId));
  const ids = new Set<string>();
  const uniqueCalls: NormalizedCall[] = [];
  for (const c of calls) {
    if (!c.id.trim()) { warnings.push({code:"missing-call-id",severity:"warning",message:"CDR record has no call ID and cannot be safely deduplicated."}); uniqueCalls.push(c); continue; }
    if (ids.has(c.id)) { warnings.push({code:"duplicate-call",severity:"error",message:"Duplicate CDR record excluded from calculations.",recordId:c.id}); continue; }
    ids.add(c.id); uniqueCalls.push(c);
  }
  const statusCounts = { answeredWithin:0, answeredAfter:0, abandoned:0, terminated:0 };
  let talk=0, hold=0, acw=0, waiting=0, short=0, rtq=0;
  const answeredRows: NormalizedCall[] = [];
  const agentAgg = new Map<string,{name:string;extension:string|null;offered:number;answered:number;tht:number}>();
  for (const c of uniqueCalls) {
    const isAnswered = c.status === "answered_within" || c.status === "answered_after";
    if (c.status === "answered_within") statusCounts.answeredWithin++;
    else if (c.status === "answered_after") statusCounts.answeredAfter++;
    else if (c.status === "abandoned") statusCounts.abandoned++;
    else if (c.status === "terminated") statusCounts.terminated++;
    else { warnings.push({code:"unknown-call-status",severity:"warning",message:"Unrecognized call status excluded from defined call categories.",recordId:c.id}); continue; }
    if (!c.extension && c.agentId) warnings.push({code:"missing-agent-extension",severity:"warning",message:"Agent extension is missing.",recordId:c.id});
    const key = c.agentId || c.extension || c.agentName || "unassigned";
    const a = agentAgg.get(key) ?? {name:c.agentName || "Unassigned",extension:c.extension || null,offered:0,answered:0,tht:0};
    a.offered++;
    if (isAnswered) {
      answeredRows.push(c); a.answered++;
      const t=validSeconds(c.talkSeconds), h=validSeconds(c.holdSeconds), w=validSeconds(c.waitingSeconds), ac=validSeconds(c.acwSeconds);
      if (t===null) warnings.push({code:"missing-talk-time",severity:"warning",message:"Talk Time is missing or invalid.",recordId:c.id}); else talk+=t;
      if (h===null) warnings.push({code:"missing-hold-time",severity:"warning",message:"Hold Time is missing or invalid.",recordId:c.id}); else hold+=h;
      if (ac===null) warnings.push({code:"missing-acw-time",severity:"warning",message:"ACW Time is missing or invalid.",recordId:c.id}); else acw+=ac;
      if (w===null) warnings.push({code:"missing-wait-time",severity:"warning",message:"Waiting Time is missing or invalid.",recordId:c.id}); else waiting+=w;
      if (c.shortCall === true) short++;
      if (c.rtq === true) rtq++;
      a.tht += (t ?? 0)+(h ?? 0)+(ac ?? 0);
    }
    agentAgg.set(key,a);
  }
  const offered = statusCounts.answeredWithin+statusCounts.answeredAfter+statusCounts.abandoned+statusCounts.terminated;
  const answered = statusCounts.answeredWithin+statusCounts.answeredAfter;
  const allHandlingAvailable = answeredRows.every(c=>validSeconds(c.talkSeconds)!==null && validSeconds(c.holdSeconds)!==null && validSeconds(c.acwSeconds)!==null);
  const allWaitingAvailable = answeredRows.every(c=>validSeconds(c.waitingSeconds)!==null);
  const tht = allHandlingAvailable ? talk+hold+acw : null;
  const workComplete = (key: keyof NormalizedWorkRecord) => work.length>0 && work.every(r=>validSeconds(r[key] as number|null|undefined)!==null);
  const sumWork = (key: keyof NormalizedWorkRecord) => work.reduce((s,r)=>s+(validSeconds(r[key] as number|null|undefined) ?? 0),0);
  const productive = workComplete("productiveSeconds") ? sumWork("productiveSeconds") : null;
  const available = workComplete("availableSeconds") ? sumWork("availableSeconds") : null;
  const staff = workComplete("staffSeconds") ? sumWork("staffSeconds") : null;
  const planned = workComplete("plannedSeconds") ? sumWork("plannedSeconds") : null;
  const outAdherence = workComplete("outOfAdherenceSeconds") ? sumWork("outOfAdherenceSeconds") : null;
  const logged = workComplete("actualLoggedInSeconds") ? sumWork("actualLoggedInSeconds") : null;
  const scheduled = workComplete("scheduledSeconds") ? sumWork("scheduledSeconds") : null;
  const lost = workComplete("lostOrNonProductiveSeconds") ? sumWork("lostOrNonProductiveSeconds") : null;
  const lateRecords = work.filter(r=>r.scheduledLogin && r.actualLogin);
  let late: number|null = null;
  if (lateRecords.length) {
    let sum=0;
    for (const r of lateRecords) {
      const p=minsSinceMidnight(r.scheduledLogin), a=minsSinceMidnight(r.actualLogin);
      if (p===null || a===null) { warnings.push({code:"invalid-login-time",severity:"warning",message:"Scheduled or actual login time is invalid.",recordId:r.id}); continue; }
      sum+=Math.max(0,(a-p)*60);
    }
    late=sum;
  }
  const answeredStatusRecon = statusCounts.answeredWithin+statusCounts.answeredAfter === answered;
  const offeredRecon = statusCounts.answeredWithin+statusCounts.answeredAfter+statusCounts.abandoned+statusCounts.terminated === offered;
  const thtRecon = tht===null ? null : Math.abs(tht-(talk+hold+acw)) <= (input.toleranceSeconds ?? 1);
  const definitions: Array<{id:KpiId;label:string;value:number|null;unit:KpiValue["unit"];formula:string;source:string}> = [
    {id:"offeredCalls",label:"Offered Calls",value:offered,unit:"calls",formula:"Answered Calls + Abandoned Calls + Terminated Calls",source:"Unique CDR records classified by call status"},
    {id:"answeredCalls",label:"Answered Calls",value:answered,unit:"calls",formula:"Answered Within Threshold + Answered After Threshold",source:"CDR status: answered within / after threshold"},
    {id:"abandonmentRate",label:"Abandonment Rate",value:pct(statusCounts.abandoned,offered) ,unit:"percent",formula:"(Total Abandoned Calls / Total Offered Calls) * 100",source:"CDR abandoned status / unique offered calls"},
    {id:"rtqRate",label:"RTQ %",value:uniqueCalls.some(c=>typeof c.rtq==="boolean")?pct(rtq,offered):null,unit:"percent",formula:"(RTQ Calls / Offered Calls) * 100",source:"CDR RTQ flag and unique offered calls"},
    {id:"workloadMinutes",label:"Workload",value:answeredRows.length && tht!==null ? offered*(tht/answered)/60 : null,unit:"minutes",formula:"(Total Offered Calls * AHT in Seconds) / 60",source:"Unique CDR calls; AHT derived from total handling time / answered calls"},
    {id:"tht",label:"THT",value:tht,unit:"seconds",formula:"Talk Time + Hold Time + ACW Time",source:"Answered CDR rows: Talk + Hold + ACW"},
    {id:"aht",label:"AHT",value:tht===null?null:div(tht,answered),unit:"seconds",formula:"Total Handling Time / Total Answered Calls",source:"Aggregated THT / aggregated answered calls"},
    {id:"ahlt",label:"AHLT",value:answeredRows.every(c=>validSeconds(c.holdSeconds)!==null)?div(hold,answered):null,unit:"seconds",formula:"Total Hold Time / Total Answered Calls",source:"Answered CDR rows: Hold Time"},
    {id:"shortCallsRate",label:"Short Calls %",value:uniqueCalls.some(c=>typeof c.shortCall==="boolean")?pct(short,answered):null,unit:"percent",formula:"(Short Calls Answered / Total Answered Calls) * 100",source:"Answered CDR short-call flag"},
    {id:"sla",label:"Service Level %",value:pct(statusCounts.answeredWithin,offered),unit:"percent",formula:"(Calls Answered Within Threshold / Total Offered Calls) * 100",source:"CDR answered-within-threshold category"},
    {id:"pca",label:"PCA %",value:pct(answered,offered),unit:"percent",formula:"(Total Answered Calls / Total Offered Calls) * 100",source:"Answered CDR categories / offered calls"},
    {id:"asa",label:"ASA",value:allWaitingAvailable?div(waiting,answered):null,unit:"seconds",formula:"Total Waiting Time for Answered Calls / Total Answered Calls",source:"Answered CDR rows: Routing / Waiting Time"},
    {id:"occupancy",label:"Occupancy %",value:tht!==null&&available!==null?pct(tht,tht+available):null,unit:"percent",formula:"(Total Handling Time / (Total Handling Time + Available Time)) * 100",source:"CDR THT + agent available-time records"},
    {id:"utilization",label:"Utilization %",value:productive!==null&&available!==null&&staff!==null?pct(productive+available,staff):null,unit:"percent",formula:"((Productive Time + Available Time) / Staff Time) * 100",source:"Agent work records: Productive + Available / Staff Time"},
    {id:"adherence",label:"Adherence %",value:planned!==null&&outAdherence!==null?pct(planned-outAdherence,planned):null,unit:"percent",formula:"((Planned Time - Out of Adherence Time) / Planned Time) * 100",source:"Agent schedule and adherence records"},
    {id:"conformance",label:"Conformance %",value:logged!==null&&scheduled!==null?pct(logged,scheduled):null,unit:"percent",formula:"(Actual Logged-in Time / Scheduled Time) * 100",source:"Agent login activity + scheduled work records"},
    {id:"shrinkage",label:"Shrinkage / Absenteeism %",value:lost!==null&&scheduled!==null?pct(lost,scheduled):null,unit:"percent",formula:"(Lost or Non-Productive Hours / Scheduled Hours) * 100",source:"Attendance and non-productive work records"},
    {id:"lateMinutes",label:"Late Minutes",value:late===null?null:late/60,unit:"minutes",formula:"MAX(0, (Actual Login - Scheduled Login) * 1440)",source:"Scheduled login vs actual login; stored in seconds and displayed in minutes"}
  ];
  const kpis = definitions.map(d=>({ ...d, ...targetValue(d.id,d.value,input.targets), warning:d.value===null?"Required source data unavailable or incomplete":undefined }));
  const ranking = [...agentAgg.entries()].map(([id,a])=>({id,name:a.name,extension:a.extension,offered:a.offered,answered:a.answered,aht:div(a.tht,a.answered)})).sort((a,b)=>b.offered-a.offered);
  return {scope,scopeId:input.scopeId??"all",scopeName:input.scopeName??"All",period:input.period,from:input.from,to:input.to,kpis,warnings,reconciliation:{answeredMatches:answeredStatusRecon,offeredMatches:offeredRecon,thtMatches:thtRecon},agentRanking:ranking};
}
