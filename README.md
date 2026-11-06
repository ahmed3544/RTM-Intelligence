# RTM Intelligence

An English-first AI reporting workspace for Excel and CSV data.

## Current scaffold
- Next.js App Router + TypeScript
- Dashboard shell and reporting module navigation
- Dependencies prepared for Excel parsing, CSV parsing, and charts
- No real upload, persistence, authentication, or AI execution is connected yet

## Run locally
```bash
npm install
npm run dev
```
Open http://localhost:3000.

## Planned implementation
1. Secure upload and workbook inspection (XLSX/XLS/CSV)
2. Sheet/column profiling and data preview
3. Deterministic calculation engine with auditable formulas
4. AI request planner that translates natural-language prompts into validated report specifications
5. Dashboard visualizations and Excel/PDF exports
6. Authentication, private storage, row-level access, and deployment

## Security
Do not commit API keys or database secrets. Use server-side environment variables. Treat uploaded spreadsheets as untrusted input and validate file type, size, formulas, and content before processing.
