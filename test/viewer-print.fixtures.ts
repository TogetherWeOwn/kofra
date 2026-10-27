// Synthetic documents only: shared by workerd and disposable-browser print tests.
export const printCapFiles = {
  "capped.txt": `${"x".repeat(1024 * 1024 + 32)}\nUNRENDERED_CODE_TAIL`,
  "capped.csv": ["name,value", ...Array.from({ length: 2001 }, (_, i) => `row-${i},${i}`)].join("\n"),
  "capped.json": JSON.stringify(Array.from({ length: 20_100 }, (_, i) => i)),
  "capped.ipynb": JSON.stringify({ cells: [{ cell_type: "code", source: "pass", outputs: [{ output_type: "stream", text: `${"x".repeat(100_001)}UNRENDERED_NOTEBOOK_TAIL` }] }] }),
};
export const printLongToken = `report/${"unbroken-path-segment".repeat(18)}/final.txt`;
export const printCsvHeaders = ["Region", "Project", "Owner", "Status", "Period", "Reference", "Notes", "Total"];
export const printCsv = [
  printCsvHeaders.join(","),
  ...Array.from({ length: 160 }, (_, i) =>
    [`region-${i}`, "sample", "recipient", "ready", "2026", printLongToken, `row-${i}`, `${i}`].join(",")),
].join("\n");
export const printCode = Array.from({ length: 100 }, (_, i) => `const line${i} = "${printLongToken}";`).join("\n");
export const printMarkdown = `# Quarterly report\n\nA printable synthetic report.\n\n\`\`\`text\n${printCode}\n\`\`\`\n\n| Reference | Result |\n| --- | --- |\n| ${printLongToken} | retained |\n\n<details><summary>Private appendix (folded)</summary><p>folded-markdown-sentinel</p></details>\n`;
export const printJson = JSON.stringify({ title: "Quarterly report", nested: { deeper: { closed: { value: "folded-json-sentinel" } } }, reference: printLongToken });
export const printNotebook = JSON.stringify({
  nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
    { cell_type: "markdown", metadata: {}, source: ["# Quarterly notebook\n", "A printable synthetic notebook."] },
    { cell_type: "code", execution_count: 1, metadata: {}, source: [printCode], outputs: [
      { output_type: "stream", name: "stdout", text: ["notebook-output-sentinel\n", printCode] },
      { output_type: "display_data", data: { "text/html": '<details><summary>Folded notebook output</summary><p>folded-notebook-sentinel</p></details>' }, metadata: {} },
    ] },
  ],
});
export const printFiles: Record<string, { viewer: string; contentType: string; content: string }> = {
  "report.md": { viewer: "markdown", contentType: "text/markdown", content: printMarkdown },
  "report.ts": { viewer: "code", contentType: "text/typescript", content: printCode },
  "report.txt": { viewer: "code", contentType: "text/plain", content: printCode },
  "report.json": { viewer: "json", contentType: "application/json", content: printJson },
  "report.csv": { viewer: "csv", contentType: "text/csv", content: printCsv },
  "report.ipynb": { viewer: "notebook", contentType: "application/x-ipynb+json", content: printNotebook },
};
