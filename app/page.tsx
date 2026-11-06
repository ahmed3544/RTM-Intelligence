import { Activity, ArrowUpRight, Bot, FileSpreadsheet, Files, LayoutDashboard, Settings2, Sparkles, UploadCloud, Clock3 } from "lucide-react";

const nav = [
  { label: "Overview", icon: LayoutDashboard, active: true },
  { label: "Data uploads", icon: Files },
  { label: "AI assistant", icon: Bot },
  { label: "Reports history", icon: Clock3 },
  { label: "Settings", icon: Settings2 }
];

export default function Home() {
  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><Activity size={21}/></span><span>RTM <b>INTELLIGENCE</b></span></div>
        <div className="workspace-label">WORKSPACE</div>
        <nav>{nav.map(({label, icon: Icon, active}) => <a className={active ? "nav-item active" : "nav-item"} href="#" key={label}><Icon size={18}/>{label}</a>)}</nav>
        <div className="sidebar-bottom"><div className="avatar">AM</div><div><strong>Workspace Admin</strong><small>Local prototype</small></div></div>
      </aside>

      <section className="main">
        <header className="topbar"><div><span className="eyebrow">REPORTING WORKSPACE</span><h1>Overview</h1></div><div className="top-actions"><span className="status-dot"/> All systems ready <button className="avatar small">AM</button></div></header>
        <div className="welcome"><div><span className="eyebrow light">YOUR DATA. YOUR REPORTS.</span><h2>Turn spreadsheets into<br/><em>clear decisions.</em></h2><p>Upload your Excel files, explore the data, and ask for the report you need.</p></div><div className="welcome-art"><div className="art-card"><FileSpreadsheet size={34}/><span>Excel data</span><ArrowUpRight size={17}/></div><div className="art-line"/></div></div>

        <div className="stats">
          <article className="stat-card"><div className="stat-icon blue"><Files size={19}/></div><span>Uploaded files</span><strong>—</strong><small>Files in your workspace</small></article>
          <article className="stat-card"><div className="stat-icon green"><FileSpreadsheet size={19}/></div><span>Data rows analyzed</span><strong>—</strong><small>Across uploaded sheets</small></article>
          <article className="stat-card"><div className="stat-icon violet"><Sparkles size={19}/></div><span>Reports generated</span><strong>—</strong><small>Your report history</small></article>
        </div>

        <div className="content-grid">
          <section className="panel upload-panel"><div className="panel-heading"><div><h3>Upload your data</h3><p>Start with an Excel workbook or CSV export.</p></div><span className="step">01</span></div><div className="dropzone"><div className="upload-icon"><UploadCloud size={25}/></div><strong>Choose a file to get started</strong><span>Supported formats: .xlsx, .xls, .csv</span><button className="primary" disabled>Upload files <ArrowUpRight size={16}/></button><small>Upload processing will be enabled in the next build.</small></div></section>
          <section className="panel assistant-panel"><div className="panel-heading"><div><h3>AI reporting assistant</h3><p>Ask questions about your uploaded data.</p></div><span className="ai-pill"><Sparkles size={13}/> AI</span></div><div className="chat-preview"><div className="bot-avatar"><Bot size={18}/></div><div className="chat-bubble"><strong>What would you like to analyze?</strong><p>Try asking for agent performance, attendance, AHT, adherence, or a monthly comparison.</p></div></div><div className="prompt-box"><span>Example: Compare agent AHT for October...</span><button disabled aria-label="Send prompt"><ArrowUpRight size={17}/></button></div><small className="muted">AI analysis will be connected after the data engine is ready.</small></section>
        </div>
        <section className="panel roadmap"><div className="panel-heading"><div><h3>Reporting modules</h3><p>Designed to work with different Excel workbooks and reporting domains.</p></div></div><div className="module-grid"><div><span className="module-icon"><Activity size={18}/></span><b>Performance</b><small>AHT, calls, THT, occupancy</small></div><div><span className="module-icon"><Clock3 size={18}/></span><b>Attendance</b><small>Late, absent, early leave</small></div><div><span className="module-icon"><FileSpreadsheet size={18}/></span><b>Data explorer</b><small>Sheets, columns, data preview</small></div><div><span className="module-icon"><Sparkles size={18}/></span><b>Custom reports</b><small>Natural-language report requests</small></div></div></section>
        <footer>RTM Intelligence <span>Prototype · English interface</span></footer>
      </section>
    </main>
  );
}
