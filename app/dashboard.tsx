"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowUpRight, Bot, FileSpreadsheet, Files, LayoutDashboard, Settings2, Sparkles, UploadCloud, Clock3, Search, Download, Trash2, FileText, Send, Table2, CheckCircle2, AlertCircle } from "lucide-react";
import * as XLSX from "xlsx";
import OfficialRtm from "../components/official-rtm";
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, type User } from "firebase/auth";
import { collection, deleteDoc, doc, getDocs, setDoc } from "firebase/firestore";
import { deleteObject, getBytes, ref as storageRef, uploadBytes } from "firebase/storage";
import { auth, db, storage } from "../lib/firebase";

type Row = Record<string, string | number | boolean | null>;
type Dataset = { id: string; name: string; sheet: string; rows: Row[]; columns: string[]; uploadedAt: string; cloudPath?: string };
type Message = { role: "assistant" | "user"; text: string };

const nav = [
  { label: "Overview", icon: LayoutDashboard },
  { label: "RTM Dashboard", icon: Activity },
  { label: "Official KPI Engine", icon: Activity },
  { label: "Data uploads", icon: Files },
  { label: "AI assistant", icon: Bot },
  { label: "Reports history", icon: Clock3 },
  { label: "Settings", icon: Settings2 },
];

const numberValue = (v: unknown) => {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[, %$]/g, ""));
    return Number.isFinite(n) && v.trim() !== "" ? n : null;
  }
  return null;
};
const safeName = (v: unknown) => String(v ?? "").trim();
const findHeaderRow = (matrix: unknown[][]): number => {
  const known = new Set(["agent","loggedin","loggedout","totallogintime","pause","pausereason","unpause","totalpausetime","totalpauses","laststatus","handlingduration","routingduration","callfrom","callduration","id","cdrid"]);
  let bestIndex = matrix.findIndex(row => row.some(cell => safeName(cell) !== ""));
  let bestScore = 0;
  matrix.slice(0, 25).forEach((row, index) => {
    const values = row.map(cell => safeName(cell).toLowerCase().replace(/[^a-z0-9]/g, ""));
    const score = values.filter(value => known.has(value)).length;
    if (score > bestScore) { bestScore = score; bestIndex = index; }
  });
  return bestIndex;
};

const DB_NAME = "rtm-intelligence-local";
const DB_STORE = "datasets";
function openLocalDb(): Promise<IDBDatabase> {
  return new Promise((resolve,reject) => {
    const request = indexedDB.open(DB_NAME,1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE,{keyPath:"id"});
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function readSavedDatasets(): Promise<Dataset[]> {
  const db = await openLocalDb();
  return new Promise((resolve,reject) => {
    const tx = db.transaction(DB_STORE,"readonly");
    const request = tx.objectStore(DB_STORE).getAll();
    request.onsuccess = () => resolve(request.result as Dataset[]);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}
async function saveDatasetsLocally(items: Dataset[]) {
  const db = await openLocalDb();
  return new Promise<void>((resolve,reject) => {
    const tx = db.transaction(DB_STORE,"readwrite");
    const store = tx.objectStore(DB_STORE);
    store.clear();
    items.forEach(item=>store.put(item));
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  });
}


async function syncDatasetToCloud(uid: string, dataset: Dataset): Promise<Dataset> {
  const path = `users/${uid}/datasets/${dataset.id}.json`;
  const payload = new Blob([JSON.stringify(dataset)], { type: "application/json" });
  await uploadBytes(storageRef(storage, path), payload, { contentType: "application/json" });
  await setDoc(doc(db, "users", uid, "datasets", dataset.id), {
    id: dataset.id, name: dataset.name, sheet: dataset.sheet,
    uploadedAt: dataset.uploadedAt, cloudPath: path,
    rowCount: dataset.rows.length, columnCount: dataset.columns.length,
  });
  return { ...dataset, cloudPath: path };
}

async function deleteCloudDataset(uid: string, dataset: Dataset) {
  await deleteDoc(doc(db, "users", uid, "datasets", dataset.id));
  if (dataset.cloudPath) {
    try { await deleteObject(storageRef(storage, dataset.cloudPath)); } catch { /* Already absent. */ }
  }
}

const norm = (v: unknown) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const findColumn = (columns: string[], patterns: RegExp[]) => columns.find(c => patterns.some(p => p.test(norm(c))));
const durationSeconds = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v > 0 && v < 1 ? v * 86400 : v;
  if (typeof v !== "string" || !v.trim()) return null;
  const value = v.trim();
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value);
  const parts = value.split(":").map(Number);
  if (parts.length === 3 && parts.every(Number.isFinite)) return parts[0]*3600 + parts[1]*60 + parts[2];
  if (parts.length === 2 && parts.every(Number.isFinite)) return parts[0]*60 + parts[1];
  return null;
};
type AgentMetric = { agent: string; calls: number; answered: number; seconds: number; aht: number | null };
function calculateRtm(data: Dataset | undefined) {
  if (!data) return null;
  const cols = data.columns;
  const agentCol = findColumn(cols, [/^(agent|agentname|agentfullname|username|user|employee|employeename|extension|owner)$/,/agentname/,/employeename/]);
  const durationCol = findColumn(cols, [/^(duration|callduration|talktime|handlingtime|totalduration|conversationduration|ahtseconds|durationseconds)$/,/callduration/,/talktime/,/handlingtime/,/durationsec/]);
  const statusCol = findColumn(cols, [/^(status|disposition|callstatus|result|callresult|finalstatus)$/,/disposition/,/callstatus/]);
  const answeredCountCol = findColumn(cols, [/^(answered|answeredcalls|connectedcalls|handledcalls)$/]);
  const callCountCol = findColumn(cols, [/^(calls|totalcalls|callcount|offeredcalls)$/]);
  const durationRows = data.rows.map(row => durationCol ? durationSeconds(row[durationCol]) : null);
  const hasDuration = durationRows.some(v => v !== null);
  const isAnswered = (row: Row, i: number) => {
    if (answeredCountCol) return (numberValue(row[answeredCountCol]) ?? 0) > 0;
    if (statusCol) { const status = String(row[statusCol] ?? ""); if (/no answer|unanswered|missed|abandon|busy|failed|cancel/i.test(status)) return false; return /answer|connect|complete|handled|success/i.test(status); }
    return durationRows[i] !== null && (durationRows[i] ?? 0) > 0;
  };
  const calls = callCountCol ? data.rows.reduce((n,r)=>n+(numberValue(r[callCountCol]) ?? 0),0) : data.rows.length;
  const answered = data.rows.reduce((n,r,i)=>n+(isAnswered(r,i) ? (answeredCountCol ? numberValue(r[answeredCountCol]) ?? 0 : 1) : 0),0);
  const seconds = durationRows.reduce<number>((n,v,i)=>n+(isAnswered(data.rows[i],i) ? (v ?? 0) : 0),0);
  const grouped = new Map<string, AgentMetric>();
  data.rows.forEach((row,i) => {
    const agent = agentCol ? safeName(row[agentCol]) || "Unassigned" : "All agents";
    const item = grouped.get(agent) ?? {agent,calls:0,answered:0,seconds:0,aht:null};
    item.calls += callCountCol ? numberValue(row[callCountCol]) ?? 0 : 1;
    if (isAnswered(row,i)) item.answered += answeredCountCol ? numberValue(row[answeredCountCol]) ?? 0 : 1;
    if (isAnswered(row,i)) item.seconds += durationRows[i] ?? 0;
    grouped.set(agent,item);
  });
  const agents = [...grouped.values()].map(a=>({...a,aht:a.answered ? a.seconds/a.answered : null})).sort((a,b)=>b.calls-a.calls);
  const extra = [
    ["Adherence", [/adherence/]], ["Utilization", [/utilization/]], ["Occupancy", [/occupancy/]],
    ["Conformance", [/conformance/]], ["Absenteeism", [/absenteeism/]], ["TTT", [/^ttt$/, /total talk time/]]
  ].map(([label, patterns]) => {
    const c = findColumn(cols, patterns as RegExp[]);
    const vals = c ? data.rows.map(r=>numberValue(r[c])).filter((v):v is number=>v!==null) : [];
    return {label:String(label), value:vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : null, column:c};
  });
  return {calls,answered,seconds,aht:answered && hasDuration ? seconds/answered : null,agents,agentCol,durationCol,statusCol,hasDuration,extra};
}


export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [section, setSection] = useState("Overview");
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [storageReady, setStorageReady] = useState(false);
  const [selected, setSelected] = useState("");
  const [sheetIndex, setSheetIndex] = useState(0);
  const [search, setSearch] = useState("");
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<Message[]>([{ role: "assistant", text: "Upload an Excel or CSV file, then ask me about its columns, rows, agent performance, AHT, calls, attendance, or other numeric metrics. I calculate answers from the data currently loaded in this browser." }]);
  const [reports, setReports] = useState<{name:string; date:string; rows:number}[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const current = datasets.find(d => d.id === selected) ?? datasets[0];
  const [previewPage, setPreviewPage] = useState(0);
  const [dark, setDark] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [cloudBusy, setCloudBusy] = useState(false);

  useEffect(() => {
    let active = true;
    readSavedDatasets().then(saved => {
      if (!active) return;
      if (saved.length) {
        setDatasets(saved);
        setSelected(saved[0].id);
        setNotice(`Restored ${saved.length} saved sheet(s) from this browser.`);
      }
    }).catch(() => {
      if (active) setNotice("Local saved data could not be loaded in this browser.");
    }).finally(() => { if (active) setStorageReady(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    saveDatasetsLocally(datasets).catch(() => setNotice("Could not save data locally. Check browser storage permissions or available space."));
  }, [datasets, storageReady]);

  useEffect(() => onAuthStateChanged(auth, nextUser => {
    setUser(nextUser);
    setAuthReady(true);
  }), []);

  useEffect(() => {
    if (!authReady || !user || !storageReady) return;
    let active = true;
    setCloudBusy(true);
    (async () => {
      const snapshot = await getDocs(collection(db, "users", user.uid, "datasets"));
      const cloudItems: Dataset[] = [];
      for (const item of snapshot.docs) {
        const meta = item.data();
        if (typeof meta.cloudPath !== "string") continue;
        const bytes = await getBytes(storageRef(storage, meta.cloudPath));
        const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Dataset;
        if (parsed && Array.isArray(parsed.rows) && Array.isArray(parsed.columns)) {
          cloudItems.push({ ...parsed, id: item.id, cloudPath: meta.cloudPath });
        }
      }
      if (!active) return;
      if (cloudItems.length) {
        setDatasets(cloudItems);
        setSelected(cloudItems[0].id);
        setNotice(`Loaded ${cloudItems.length} sheet(s) from Firebase Cloud Storage.`);
      } else {
        const localItems = await readSavedDatasets();
        if (localItems.length) {
          const migrated: Dataset[] = [];
          for (const item of localItems) migrated.push(await syncDatasetToCloud(user.uid, item));
          if (!active) return;
          setDatasets(migrated);
          setSelected(migrated[0]?.id ?? "");
          setNotice(`Synced ${migrated.length} existing local sheet(s) to your Firebase account.`);
        } else {
          setDatasets([]);
          setNotice("Cloud storage is connected. Uploads will now appear on your other signed-in devices.");
        }
      }
    })().catch(error => {
      console.error("Firebase restore failed:", error);
      if (active) setNotice("Could not load cloud files. Check that Firestore and Storage are enabled and their security rules are published.");
    }).finally(() => { if (active) setCloudBusy(false); });
    return () => { active = false; };
  }, [authReady, user, storageReady]);



  const totalRows = datasets.reduce((n, d) => n + d.rows.length, 0);
  const rtm = useMemo(() => calculateRtm(current), [current]);
  const filteredRows = useMemo(() => {
    if (!current) return [];
    const q = search.toLowerCase().trim();
    return q ? current.rows.filter(row => Object.values(row).some(v => String(v ?? "").toLowerCase().includes(q))) : current.rows;
  }, [current, search]);
  const pageRows = filteredRows.slice(previewPage * 25, previewPage * 25 + 25);

  async function handleFiles(files: FileList | File[]) {
    setBusy(true); setNotice("");
    try {
      const added: Dataset[] = [];
      for (const file of Array.from(files)) {
        const ext = file.name.split(".").pop()?.toLowerCase();
        if (!["xlsx", "xls", "csv"].includes(ext || "")) { setNotice("Unsupported file: " + file.name); continue; }
        const buffer = await file.arrayBuffer();
        const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName];
          const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: true });
          if (!matrix.length) continue;
          const headerRowIndex = findHeaderRow(matrix);
          if (headerRowIndex < 0) continue;
          const rawHeaders = matrix[headerRowIndex].map((v, i) => safeName(v) || `Column ${i + 1}`);
          const headers = rawHeaders.map((h, i) => rawHeaders.indexOf(h) === i ? h : `${h} (${i + 1})`);
          const rows: Row[] = matrix.slice(headerRowIndex + 1).filter(row => row.some(v => v !== null && v !== "")).map(row => {
            const item: Row = {};
            headers.forEach((h, i) => {
              const v = row[i];
              item[h] = v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "bigint" ? String(v) : (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v == null) ? v as string | number | boolean | null : String(v);
            });
            return item;
          });
          if (!rows.length) continue;
          added.push({ id: crypto.randomUUID(), name: file.name, sheet: sheetName, rows, columns: headers, uploadedAt: new Date().toLocaleString() });
        }
      }
      if (added.length) {
        const synced: Dataset[] = [];
        let cloudFailed = false;
        for (const item of added) {
          try { synced.push(await syncDatasetToCloud(user!.uid, item)); }
          catch (error) { console.error("Cloud upload failed:", error); synced.push(item); cloudFailed = true; }
        }
        setDatasets(prev => [...prev, ...synced]);
        setSelected(synced[0].id);
        setSection("Data uploads");
        setPreviewPage(0);
        setNotice(cloudFailed
          ? `Imported ${added.length} sheet(s), but cloud sync failed for one or more. Local copies remain on this device.`
          : `Imported and saved ${added.length} sheet(s) to Firebase. They will appear on your other signed-in devices.`);
      } else if (!notice) setNotice("No tabular data found. Make sure the first non-empty row contains column headers.");
    } catch (e) {
      setNotice("Could not read this file. Please check that it is a valid Excel or CSV workbook.");
    } finally { setBusy(false); if (inputRef.current) inputRef.current.value = ""; }
  }

  function exportWorkbook() {
    if (!current) return;
    const ws = XLSX.utils.json_to_sheet(current.rows, { header: current.columns });
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, current.sheet.slice(0,31));
    XLSX.writeFile(wb, current.name.replace(/\.(xlsx|xls|csv)$/i, "") + "-report.xlsx");
  }
  function exportAll() {
    if (!datasets.length) return;
    const wb = XLSX.utils.book_new();
    datasets.forEach((d, i) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(d.rows, {header:d.columns}), (d.sheet || `Sheet ${i+1}`).slice(0,31) || `Sheet ${i+1}`));
    XLSX.writeFile(wb, "RTM-Intelligence-Export.xlsx");
  }
  function makeReport() {
    if (!current) { setNotice("Upload a data file before generating a report."); return; }
    setReports(prev => [{name: current.name + " — Data summary", date:new Date().toLocaleString(), rows:current.rows.length}, ...prev]);
    setNotice("Report summary prepared. Use Export Excel or Print / Save PDF to download it.");
    setSection("Reports history");
  }
  function answerQuestion() {
    const q = question.trim();
    if (!q) return;
    setMessages(prev => [...prev, {role:"user", text:q}]); setQuestion("");
    if (!current) { setMessages(prev => [...prev, {role:"assistant",text:"Please upload an Excel or CSV file first. I can only calculate from data loaded in this session."}]); return; }
    const lower = q.toLowerCase();
    let answer = "";
    if (/\baht\b|average handling time|handling time average/i.test(lower)) {
      const calc = calculateRtm(current);
      if (calc?.aht !== null && calc?.aht !== undefined) {
        const secs = Math.round(calc.aht);
        answer = `AHT = total call duration ÷ answered calls = ${calc.seconds.toLocaleString(undefined,{maximumFractionDigits:0})} seconds ÷ ${calc.answered.toLocaleString()} answered calls = ${Math.floor(secs/60)}m ${String(secs%60).padStart(2,"0")}s (${secs} seconds).`;
      } else answer = `I couldn't calculate AHT reliably. I detected duration column: ${calc?.durationCol ?? "not found"}; answered/status column: ${calc?.statusCol ?? "not found"}. Please check the column names or upload the CDR export.`;
      setMessages(prev => [...prev, {role:"assistant",text:answer}]);
      return;
    }
    const metric = current.columns.find(c => lower.includes(c.toLowerCase())) ||
      current.columns.find(c => /(aht|adherence|utilization|occupancy|calls|call count|duration|talk time|login|aux|late|absent|conformance|ttt)/i.test(c) && lower.split(/\s+/).some(w => w.length > 2 && c.toLowerCase().includes(w)));
    if (/how many|number of|count|rows|records/i.test(lower)) answer = `The selected sheet contains ${current.rows.length.toLocaleString()} data rows and ${current.columns.length} columns.`;
    else if (/columns|fields|headers/i.test(lower)) answer = `Columns in ${current.sheet}: ${current.columns.join(", ")}.`;
    else if (metric) {
      const values = current.rows.map(r => numberValue(r[metric])).filter((v): v is number => v !== null);
      if (!values.length) answer = `I found the column “${metric}”, but it has no numeric values to aggregate.`;
      else {
        const sum = values.reduce((a,b)=>a+b,0), avg = sum / values.length;
        const min = Math.min(...values), max = Math.max(...values);
        answer = `For “${metric}” across ${values.length} numeric records: average ${avg.toLocaleString(undefined,{maximumFractionDigits:2})}, total ${sum.toLocaleString(undefined,{maximumFractionDigits:2})}, minimum ${min.toLocaleString()}, maximum ${max.toLocaleString()}.`;
      }
    } else if (/summary|overview|analy[sz]e|report/i.test(lower)) {
      const numeric = current.columns.filter(c => current.rows.some(r => numberValue(r[c]) !== null));
      answer = `Data summary for ${current.name} / ${current.sheet}: ${current.rows.length} rows, ${current.columns.length} columns. Numeric fields detected: ${numeric.join(", ") || "none"}. Ask for a specific field to calculate its average, total, minimum, and maximum.`;
    } else answer = `I can inspect ${current.rows.length} rows across ${current.columns.length} columns. Try: “How many rows?”, “List columns”, “Average AHT”, “Total calls”, or “Summarize this data”. This assistant currently uses deterministic local calculations; it is not connected to a generative AI service yet.`;
    setMessages(prev => [...prev, {role:"assistant",text:answer}]);
  }

  async function removeDataset(id:string) {
    const target = datasets.find(d => d.id === id);
    setDatasets(prev => prev.filter(d=>d.id!==id));
    if (selected===id) setSelected(datasets.find(d=>d.id!==id)?.id ?? "");
    if (target && user) {
      try { await deleteCloudDataset(user.uid, target); setNotice("Dataset deleted from Firebase and this device."); }
      catch { setNotice("Removed locally, but cloud deletion failed. Please try again."); }
    } else setNotice("Dataset removed from this device.");
  }

  async function clearWorkspace() {
    if (user) {
      try { await Promise.all(datasets.map(item => deleteCloudDataset(user.uid, item))); }
      catch { setNotice("Some cloud files could not be deleted. Please retry."); return; }
    }
    setDatasets([]);
    setSelected("");
    setReports([]);
    setMessages([{role:"assistant",text:"Workspace cleared. Upload a workbook to begin again."}]);
    setNotice("Workspace cleared from cloud and this device.");
  }

  async function loginWithGoogle() {
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error("Google sign-in failed:", error);
      const authError = error as { code?: string; message?: string };
      const code = authError?.code || "auth/unknown";
      const friendly: Record<string,string> = {
        "auth/unauthorized-domain": "This website is not authorized in Firebase. Add rtm-intelligence-flax.vercel.app under Authentication → Settings → Authorized domains.",
        "auth/operation-not-allowed": "Google sign-in is disabled. Enable Google under Firebase Authentication → Sign-in method.",
        "auth/popup-blocked": "The browser blocked the Google sign-in popup. Allow popups for this website and try again.",
        "auth/popup-closed-by-user": "The Google sign-in window was closed before finishing. Try again.",
        "auth/cancelled-popup-request": "A previous Google sign-in popup is still active. Close it and try again.",
        "auth/network-request-failed": "Network request failed. Check your internet connection or browser extensions and try again.",
        "auth/invalid-api-key": "The Firebase API key is invalid. Check the Firebase web app configuration."
      };
      setNotice((friendly[code] || "Google sign-in failed: " + (authError?.message || "Unknown Firebase error")) + " [" + code + "]");
    }
  }

  const title = section;
  if (!authReady) return <main className="auth-screen"><section className="auth-card"><div className="brand-mark"><Activity size={22}/></div><h1>RTM Intelligence</h1><p>Connecting to your secure cloud workspace…</p></section></main>;
  if (!user) return <main className="auth-screen"><section className="auth-card"><div className="brand-mark"><Activity size={22}/></div><span className="eyebrow">CLOUD WORKSPACE</span><h1>RTM Intelligence</h1><p>Sign in to securely access your uploaded reports from any device.</p><button className="primary auth-button" onClick={loginWithGoogle}><ArrowUpRight size={16}/> Continue with Google</button><small>Your files are private to your Google account.</small></section></main>;
  return (
    <main className={dark ? "shell dark-mode" : "shell"}>
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><Activity size={21}/></span><span>RTM <b>INTELLIGENCE</b></span></div>
        <div className="workspace-label">WORKSPACE</div>
        <nav>{nav.map(({label, icon: Icon}) => <button type="button" className={section===label ? "nav-item active" : "nav-item"} onClick={()=>setSection(label)} key={label}><Icon size={18}/>{label}</button>)}</nav>
        <div className="sidebar-bottom"><div className="avatar">AM</div><div><strong>Workspace Admin</strong><small>{user.email ?? "Cloud workspace"}</small></div></div>
      </aside>

      <section className="main">
        <header className="topbar"><div><span className="eyebrow">REPORTING WORKSPACE</span><h1>{title}</h1></div><div className="top-actions"><span className="status-dot"/> Ready <button className="avatar small" type="button" onClick={()=>setSection("Settings")}>AM</button></div></header>

        {notice && <div className="notice" role="status"><CheckCircle2 size={16}/><span>{notice}</span><button onClick={()=>setNotice("")} aria-label="Dismiss">×</button></div>}

        {section==="Overview" && <>
          <div className="welcome"><div><span className="eyebrow light">YOUR DATA. YOUR REPORTS.</span><h2>Turn spreadsheets into<br/><em>clear decisions.</em></h2><p>Upload your Excel files, explore the data, and ask for the report you need.</p><button className="primary" onClick={()=>inputRef.current?.click()}><UploadCloud size={16}/> Upload a workbook</button></div><div className="welcome-art"><div className="art-card"><FileSpreadsheet size={34}/><span>Excel data</span><ArrowUpRight size={17}/></div><div className="art-line"/></div></div>
          <div className="stats">
            <article className="stat-card"><div className="stat-icon blue"><Files size={19}/></div><span>Uploaded sheets</span><strong>{datasets.length}</strong><small>Saved in Firebase Cloud</small></article>
            <article className="stat-card"><div className="stat-icon green"><FileSpreadsheet size={19}/></div><span>Data rows analyzed</span><strong>{totalRows.toLocaleString()}</strong><small>Across uploaded sheets</small></article>
            <article className="stat-card"><div className="stat-icon violet"><Sparkles size={19}/></div><span>Reports generated</span><strong>{reports.length}</strong><small>Current session</small></article>
          </div>
          <div className="content-grid">
            <section className="panel upload-panel"><div className="panel-heading"><div><h3>Upload your data</h3><p>Excel workbooks and CSV exports are supported.</p></div><span className="step">01</span></div><div className="dropzone" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();void handleFiles(e.dataTransfer.files);}}><div className="upload-icon"><UploadCloud size={25}/></div><strong>{busy ? "Reading your file..." : "Choose or drop files to get started"}</strong><span>Supported formats: .xlsx, .xls, .csv</span><button className="primary" onClick={()=>inputRef.current?.click()} disabled={busy}>{busy ? "Processing..." : "Choose files"} <ArrowUpRight size={16}/></button><small>Files are uploaded securely to Firebase and available on your other signed-in devices.</small></div></section>
            <section className="panel assistant-panel"><div className="panel-heading"><div><h3>Reporting assistant</h3><p>Ask questions about your uploaded data.</p></div><span className="ai-pill"><Sparkles size={13}/> ANALYTICS</span></div><div className="chat-preview"><div className="bot-avatar"><Bot size={18}/></div><div className="chat-bubble"><strong>What would you like to analyze?</strong><p>Try “How many rows?”, “Average AHT”, or “List columns”.</p></div></div><button className="secondary full" onClick={()=>setSection("AI assistant")}>Open assistant <ArrowUpRight size={16}/></button></section>
          </div>
        </>}


        {section==="Official KPI Engine" && <OfficialRtm datasets={datasets} />}

        {section==="RTM Dashboard" && <section className="panel">
          <div className="panel-heading"><div><h3>RTM performance dashboard</h3><p>Automatic calculations from the selected sheet. Select the CDR export to calculate call metrics.</p></div><button className="secondary" onClick={()=>setSection("Data uploads")}>Choose dataset</button></div>
          {!current || !rtm ? <div className="empty-state"><Activity size={32}/><b>Upload your RTM exports</b><span>Start with the CDR file, then select the relevant sheet.</span><button className="primary" onClick={()=>inputRef.current?.click()}>Upload files</button></div> : <>
            <div className="active-data"><Table2 size={16}/>Analyzing {current.name} / {current.sheet} · {current.rows.length.toLocaleString()} records</div>
            <div className="stats">
              <article className="stat-card"><div className="stat-icon blue"><Files size={19}/></div><span>Total calls</span><strong>{rtm.calls.toLocaleString()}</strong><small>{current.rows.length.toLocaleString()} source rows</small></article>
              <article className="stat-card"><div className="stat-icon green"><CheckCircle2 size={19}/></div><span>Answered calls</span><strong>{rtm.answered.toLocaleString()}</strong><small>{rtm.calls ? (rtm.answered/rtm.calls*100).toFixed(1)+"% answer rate" : "No calls detected"}</small></article>
              <article className="stat-card"><div className="stat-icon violet"><Clock3 size={19}/></div><span>Average handling time</span><strong>{rtm.aht===null ? "—" : Math.floor(rtm.aht/60)+"m "+String(Math.round(rtm.aht)%60).padStart(2,"0")+"s"}</strong><small>{rtm.aht===null ? "Duration / answered calls unavailable" : Math.round(rtm.aht)+" seconds per answered call"}</small></article>
              <article className="stat-card"><div className="stat-icon blue"><Activity size={19}/></div><span>Total call duration</span><strong>{Math.floor(rtm.seconds/3600)}h {Math.floor(rtm.seconds%3600/60)}m</strong><small>{Math.round(rtm.seconds).toLocaleString()} seconds</small></article>
            </div>
            <div className="settings-note"><AlertCircle size={16}/>Detected fields — Agent: {rtm.agentCol ?? "not detected"} · Duration: {rtm.durationCol ?? "not detected"} · Status: {rtm.statusCol ?? "not detected"}. AHT uses total detected duration divided by answered calls. Verify these mappings before relying on the result.</div>
            <div className="panel-heading"><div><h3>Agent performance</h3><p>Calls, answered calls, total duration and AHT by agent.</p></div></div>
            <div className="table-wrap"><table><thead><tr><th>Agent</th><th>Calls</th><th>Answered</th><th>Total duration</th><th>AHT</th></tr></thead><tbody>{rtm.agents.map(a=><tr key={a.agent}><td>{a.agent}</td><td>{a.calls.toLocaleString()}</td><td>{a.answered.toLocaleString()}</td><td>{Math.floor(a.seconds/60)}m {Math.round(a.seconds%60)}s</td><td>{a.aht===null?"—":Math.floor(a.aht/60)+"m "+String(Math.round(a.aht)%60).padStart(2,"0")+"s"}</td></tr>)}</tbody></table></div>
            <div className="panel-heading"><div><h3>Additional available KPIs</h3><p>Only shown when a matching numeric column exists in this sheet.</p></div></div>
            <div className="stats">{rtm.extra.filter(x=>x.value!==null).map(x=><article className="stat-card" key={x.label}><span>{x.label}</span><strong>{x.value!.toLocaleString(undefined,{maximumFractionDigits:2})}{/adherence|utilization|occupancy|absenteeism|conformance/i.test(x.label)?"%":""}</strong><small>Average of {x.column}</small></article>)}</div>
            <div className="settings-note"><AlertCircle size={16}/>This dashboard calculates only metrics supported by the selected file. Attendance, pause breakdown, adherence and conformance require their corresponding YASTER exports and shift schedule rules.</div>
          </>}
        </section>}

        {section==="Data uploads" && <section className="panel">
          <div className="panel-heading"><div><h3>Data workspace</h3><p>Import files, choose a sheet, and inspect your data.</p></div><button className="primary" onClick={()=>inputRef.current?.click()}><UploadCloud size={16}/> Upload files</button></div>
          {!datasets.length ? <div className="empty-state"><Files size={32}/><b>No data uploaded yet</b><span>Select an Excel workbook or CSV file to begin.</span><button className="primary" onClick={()=>inputRef.current?.click()}>Choose a file</button></div> : <>
            <div className="dataset-list">{datasets.map(d=><div className={current?.id===d.id?"dataset selected":"dataset"} key={d.id}><button className="dataset-main" onClick={()=>{setSelected(d.id);setPreviewPage(0);}}><FileSpreadsheet size={19}/><span><b>{d.name}</b><small>{d.sheet} · {d.rows.length.toLocaleString()} rows · {d.columns.length} columns</small></span></button><button className="icon-button danger" onClick={()=>removeDataset(d.id)} title="Remove"><Trash2 size={16}/></button></div>)}</div>
            {current && <><div className="table-toolbar"><div><h3>{current.sheet}</h3><small>{current.rows.length.toLocaleString()} rows · {current.columns.length} columns</small></div><div className="toolbar-actions"><div className="searchbox"><Search size={15}/><input value={search} onChange={e=>{setSearch(e.target.value);setPreviewPage(0);}} placeholder="Search rows..."/></div><button className="secondary" onClick={exportWorkbook}><Download size={15}/> Export Excel</button></div></div>
              <div className="table-wrap"><table><thead><tr>{current.columns.map(c=><th key={c}>{c}</th>)}</tr></thead><tbody>{pageRows.map((row,i)=><tr key={i}>{current.columns.map(c=><td key={c}>{row[c]===null || row[c]===undefined ? "—" : String(row[c])}</td>)}</tr>)}</tbody></table></div>
              <div className="pagination"><span>Showing {filteredRows.length ? previewPage*25+1 : 0}–{Math.min((previewPage+1)*25,filteredRows.length)} of {filteredRows.length.toLocaleString()}</span><div><button className="secondary" disabled={previewPage===0} onClick={()=>setPreviewPage(p=>p-1)}>Previous</button><button className="secondary" disabled={(previewPage+1)*25>=filteredRows.length} onClick={()=>setPreviewPage(p=>p+1)}>Next</button></div></div>
            </>}
          </>}
        </section>}

        {section==="AI assistant" && <section className="panel assistant-page"><div className="panel-heading"><div><h3>Data analysis assistant</h3><p>Answers are calculated from the selected dataset. No values are invented.</p></div><span className="ai-pill"><Sparkles size={13}/> LOCAL ANALYTICS</span></div><div className="active-data"><Table2 size={16}/>{current ? `Using: ${current.name} / ${current.sheet} (${current.rows.length} rows)` : "No dataset selected — upload a file first."}</div><div className="messages">{messages.map((m,i)=><div className={m.role==="user"?"message user-message":"message"} key={i}><div className="bot-avatar">{m.role==="assistant"?<Bot size={17}/>: "AM"}</div><p>{m.text}</p></div>)}</div><div className="suggestions">{["How many rows are in this sheet?","List all columns","Summarize this data","Calculate average AHT"].map(s=><button className="suggestion" key={s} onClick={()=>{setQuestion(s);}}>{s}</button>)}</div><form className="ask-form" onSubmit={e=>{e.preventDefault();answerQuestion();}}><input value={question} onChange={e=>setQuestion(e.target.value)} placeholder="Ask a question about your data..." /><button className="primary" type="submit"><Send size={16}/> Send</button></form></section>}

        {section==="Reports history" && <section className="panel"><div className="panel-heading"><div><h3>Reports history</h3><p>Create a workbook export or print a report to PDF.</p></div><button className="primary" onClick={makeReport} disabled={!current}><FileText size={16}/> Generate summary</button></div>{reports.length ? <div className="report-list">{reports.map((r,i)=><div className="report-item" key={i}><div className="report-icon"><FileText size={18}/></div><div><b>{r.name}</b><small>{r.date} · {r.rows} rows</small></div><button className="secondary" onClick={()=>window.print()}>Print / Save PDF</button></div>)}</div> : <div className="empty-state"><Clock3 size={32}/><b>No reports generated</b><span>Choose a dataset, then generate a data summary.</span></div>}</section>}

        {section==="Settings" && <section className="panel"><div className="panel-heading"><div><h3>Workspace settings</h3><p>Manage this browser workspace.</p></div></div><div className="settings-row"><div><b>Signed in account</b><small>{user.email ?? user.uid}</small></div><button className="secondary" onClick={()=>signOut(auth)}>Sign out</button></div><div className="settings-row"><div><b>Cloud sync</b><small>{cloudBusy ? "Loading cloud files…" : "Firebase Storage + Firestore connected"}</small></div><span className="ai-pill"><CheckCircle2 size={13}/> {cloudBusy ? "SYNCING" : "CONNECTED"}</span></div><div className="settings-row"><div><b>Appearance</b><small>Switch between light and dark workspace.</small></div><button className="secondary" onClick={()=>setDark(v=>!v)}>{dark?"Use light mode":"Use dark mode"}</button></div><div className="settings-row"><div><b>Export all uploaded data</b><small>Download all imported sheets into one Excel workbook.</small></div><button className="secondary" disabled={!datasets.length} onClick={exportAll}><Download size={15}/> Export all</button></div><div className="settings-row"><div><b>Clear current session</b><small>Remove uploaded data and generated report history from this browser session.</small></div><button className="secondary danger-text" disabled={!datasets.length&&!reports.length} onClick={()=>void clearWorkspace()}>Clear workspace</button></div><div className="settings-note"><AlertCircle size={16}/> Uploaded workbooks are stored as private files in Firebase Storage, with file records in Firestore. Only the signed-in Google account can read or change its files under the included security rules. Local browser storage is retained as a backup.</div></section>}

        <footer>RTM Intelligence <span>Firebase cloud workspace · Signed in as {user.email ?? "Google user"}</span></footer>
      </section>
      <input ref={inputRef} type="file" accept=".xlsx,.xls,.csv" multiple hidden onChange={e=>{if(e.target.files)void handleFiles(e.target.files);}}/>
    </main>
  );
}
