const { useEffect, useMemo, useState } = React;

const STORAGE_KEY = "anki-card-studio:v1";
const ANKI_CONNECT_URL = (() => {
  const host = window.location.hostname || "127.0.0.1";
  return `http://${host}:8765`;
})();
const OMNIFOCUS_BRIDGE_URL = (() => {
  const host = window.location.hostname || "127.0.0.1";
  return `http://${host}:3479`;
})();

const initialDraft = {
  deckName: "Default",
  modelName: "Basic",
  front: "",
  back: "",
  text: "这是一个 {{c1::完形填空}} 示例",
  extra: "",
  tags: "local generated",
};

const defaultModelConfig = {
  basic: "Basic",
  reversed: "Basic (and reversed card)",
  cloze: "Cloze",
};

const sampleImport = `#separator:tab
#html:true
#notetype:Basic
#deck:Default
#columns:Front\tBack\tTags
什么是间隔重复？\t按照遗忘曲线安排复习的学习方法。\tlearning anki
Anki 文本导入的常见分隔符？\ttab、comma、semicolon、pipe。\tanki import`;

function Icon({ name, size = 18 }) {
  useEffect(() => {
    if (window.lucide) window.lucide.createIcons();
  });
  return <i data-lucide={name} style={{ width: size, height: size }} aria-hidden="true" />;
}

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeTags(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return String(value || "")
    .split(/[,\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function decodeSeparator(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const map = {
    tab: "\t",
    comma: ",",
    semicolon: ";",
    space: " ",
    pipe: "|",
    colon: ":",
  };
  if (map[normalized]) return map[normalized];
  if (normalized === "\\t") return "\t";
  return value || "\t";
}

function separatorLabel(separator) {
  const map = {
    "\t": "tab",
    ",": "comma",
    ";": "semicolon",
    " ": "space",
    "|": "pipe",
    ":": "colon",
  };
  return map[separator] || separator;
}

function parseDelimitedLine(line, separator) {
  const cells = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      quoted = !quoted;
      continue;
    }

    if (char === separator && !quoted) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function stringifyCell(value, separator = "\t") {
  const text = String(value ?? "").replace(/\r?\n/g, "<br>");
  const needsQuote = text.includes(separator) || text.includes('"') || text.includes("\n");
  return needsQuote ? `"${text.replace(/"/g, '""')}"` : text;
}

function detectSeparator(lines, metadata) {
  if (metadata.separator) return decodeSeparator(metadata.separator);

  const candidates = ["\t", ",", ";", "|", ":"];
  const scored = candidates.map((separator) => {
    const score = lines.reduce((total, line) => total + Math.max(parseDelimitedLine(line, separator).length - 1, 0), 0);
    return { separator, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.score > 0 ? scored[0].separator : "\t";
}

function extractMetadata(lines) {
  return lines.reduce((acc, rawLine) => {
    const line = rawLine.trim();
    const match = line.match(/^#([^:]+):(.*)$/);
    if (!match) return acc;
    acc[match[1].trim().toLowerCase()] = match[2].trim();
    return acc;
  }, {});
}

function isHeaderLike(cells) {
  const joined = cells.join(" ").toLowerCase();
  return /(^|\s)(front|back|text|extra|tags|deck|notetype|note type|model)(\s|$)/i.test(joined);
}

function splitColumns(value, separator) {
  if (!value) return [];
  const parsed = parseDelimitedLine(value, separator);
  if (parsed.length > 1) return parsed;
  return value.split(/\s+/).map((part) => part.trim()).filter(Boolean);
}

function isSpecialColumn(column) {
  const normalized = column.toLowerCase().replace(/\s+/g, " ");
  return [
    "deck",
    "notetype",
    "note type",
    "model",
    "tags",
    "guid",
    "card",
  ].includes(normalized);
}

function analyzeAnkiText(input) {
  const rawLines = String(input || "").replace(/\r\n/g, "\n").split("\n");
  const lines = rawLines.map((line) => line.trimEnd()).filter((line) => line.trim());
  const metadata = extractMetadata(lines);
  const dataLines = lines.filter((line) => !line.trimStart().startsWith("#"));
  const separator = detectSeparator(dataLines, metadata);
  const firstCells = dataLines[0] ? parseDelimitedLine(dataLines[0], separator) : [];
  const columnsFromMetadata = splitColumns(metadata.columns, separator);
  const hasHeaderRow = !columnsFromMetadata.length && firstCells.length > 1 && isHeaderLike(firstCells);
  const columns = columnsFromMetadata.length
    ? columnsFromMetadata
    : hasHeaderRow
      ? firstCells
      : firstCells.map((_, index) => `Field ${index + 1}`);
  const rowsSource = hasHeaderRow ? dataLines.slice(1) : dataLines;
  const rows = rowsSource.map((line) => parseDelimitedLine(line, separator));
  const flattened = rows.flat().join("\n");
  const cloze = /\{\{c\d+::.+?\}\}/.test(flattened) || /cloze/i.test(metadata.notetype || metadata.model || "");
  const hasAnkiHeaders = Object.keys(metadata).length > 0;
  const hasSpecialColumns = columns.some(isSpecialColumn);
  const format = cloze
    ? "Anki Cloze 完形填空文本"
    : hasAnkiHeaders || hasSpecialColumns
      ? "Anki 文本导入格式"
      : columns.length === 2
        ? "基础正反面卡片 TSV/CSV"
        : "多字段笔记表格";

  const notes = rows
    .filter((row) => row.some(Boolean))
    .map((row) => rowToCard(row, columns, metadata, cloze));

  const warnings = [];
  if (!dataLines.length) warnings.push("没有检测到可导入的数据行。");
  if (rows.some((row) => row.length !== firstCells.length)) warnings.push("部分行的字段数量不一致，导入 Anki 前建议检查换行或分隔符。");
  if (input.includes(".apkg")) warnings.push(".apkg 是压缩包格式，当前工具识别文本/CSV/TSV 导入格式，不解析二进制牌组包。");

  return {
    columns,
    format,
    hasAnkiHeaders,
    metadata,
    notes,
    rowCount: notes.length,
    separator,
    warnings,
  };
}

function rowToCard(row, columns, metadata, cloze) {
  const lookup = {};
  columns.forEach((column, index) => {
    lookup[column.toLowerCase().replace(/\s+/g, " ")] = row[index] || "";
  });

  const tags = lookup.tags || row[columns.findIndex((column) => column.toLowerCase() === "tags")] || metadata.tags || "";
  const deckName = lookup.deck || metadata.deck || "Default";
  const modelName = lookup.notetype || lookup["note type"] || lookup.model || metadata.notetype || metadata.model || (cloze ? "Cloze" : "Basic");

  if (/cloze/i.test(modelName) || cloze) {
    return {
      id: uid(),
      deckName,
      modelName: "Cloze",
      text: lookup.text || firstRegularValue(row, columns, 0),
      extra: lookup.extra || firstRegularValue(row, columns, 1),
      tags,
      source: "import",
    };
  }

  return {
    id: uid(),
    deckName,
    modelName,
    front: lookup.front || firstRegularValue(row, columns, 0),
    back: lookup.back || firstRegularValue(row, columns, 1),
    tags,
    source: "import",
  };
}

function firstRegularValue(row, columns, wantedIndex) {
  const regular = columns
    .map((column, index) => ({ column, value: row[index] || "" }))
    .filter(({ column }) => !isSpecialColumn(column));
  return regular[wantedIndex]?.value || "";
}

function cardTitle(card) {
  return card.modelName === "Cloze" ? card.text : card.front;
}

function cardAnswer(card) {
  return card.modelName === "Cloze" ? card.extra : card.back;
}

function removeAnkiTemplateCss(value) {
  return String(value || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/\.card\s*\{[\s\S]*?\}/gi, " ")
    .replace(/(?:^|\s)[.#][\w-]+\s*\{[\s\S]*?\}/g, " ");
}

function stripHtml(value) {
  const text = removeAnkiTemplateCss(value);
  if (typeof document !== "undefined") {
    const element = document.createElement("div");
    element.innerHTML = text.replace(/<br\s*\/?>/gi, "\n");
    return removeAnkiTemplateCss(element.textContent).replace(/\s+\n/g, "\n").replace(/\n\s+/g, "\n").trim();
  }
  return removeAnkiTemplateCss(text.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).trim();
}

function fieldEntries(fields = {}) {
  return Object.entries(fields)
    .map(([name, field]) => ({
      name,
      order: Number.isFinite(field?.order) ? field.order : 999,
      value: stripHtml(field?.value || ""),
    }))
    .sort((a, b) => a.order - b.order);
}

function deckSearchQuery(deck) {
  return `deck:"${String(deck).replace(/"/g, '\\"')}"`;
}

function matchesAny(value, candidates) {
  const normalized = String(value || "").toLowerCase();
  return candidates.some((candidate) => normalized.includes(candidate.toLowerCase()));
}

function pickModel(models, current, candidates, fallback = "") {
  if (current && models.includes(current)) return current;
  return models.find((model) => matchesAny(model, candidates)) || fallback || models[0] || "";
}

function resolveModelConfig(models, current = defaultModelConfig) {
  return {
    basic: pickModel(models, current.basic, ["Basic", "基本"], current.basic),
    reversed: pickModel(models, current.reversed, ["reversed", "反向", "双向"], current.reversed),
    cloze: pickModel(models, current.cloze, ["Cloze", "填空", "完形"], current.cloze),
  };
}

function cardModelKind(card) {
  if (card.modelName === "Cloze") return "cloze";
  if (/reversed|反向|双向/i.test(card.modelName || "")) return "reversed";
  return "basic";
}

function fieldsForCard(card, modelName, modelFields) {
  const names = modelFields[modelName] || [];
  const kind = cardModelKind(card);
  const values = kind === "cloze"
    ? [card.text || "", card.extra || ""]
    : [card.front || "", card.back || ""];
  const fallbackNames = kind === "cloze" ? ["Text", "Extra"] : ["Front", "Back"];
  const fieldNames = names.length ? names : fallbackNames;

  return fieldNames.reduce((fields, name, index) => {
    fields[name] = values[index] || "";
    return fields;
  }, {});
}

function normalizeForDuplicate(value) {
  return stripHtml(value)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function cardDuplicateKey(card) {
  return [
    cardModelKind(card),
    normalizeForDuplicate(cardTitle(card)),
    normalizeForDuplicate(cardAnswer(card)),
  ].join("\u001f");
}

function dedupeCards(incomingCards, existingCards = []) {
  const seen = new Set(existingCards.map(cardDuplicateKey).filter((key) => key.replace(/\u001f/g, "")));
  const unique = [];
  let duplicateCount = 0;

  incomingCards.forEach((card) => {
    const key = cardDuplicateKey(card);
    if (!key.replace(/\u001f/g, "")) return;
    if (seen.has(key)) {
      duplicateCount += 1;
      return;
    }
    seen.add(key);
    unique.push(card);
  });

  return { unique, duplicateCount };
}

function noteDuplicateKey(note) {
  return [
    note.deckName || "",
    note.modelName || "",
    ...Object.values(note.fields || {}).map(normalizeForDuplicate),
  ].join("\u001f");
}

function dedupeNotes(notes) {
  const seen = new Set();
  const unique = [];
  let duplicateCount = 0;

  notes.forEach((note) => {
    const key = noteDuplicateKey(note);
    if (seen.has(key)) {
      duplicateCount += 1;
      return;
    }
    seen.add(key);
    unique.push(note);
  });

  return { unique, duplicateCount };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function uniqueValues(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null))];
}

function countOutside(source, excludedSets) {
  return source.filter((id) => !excludedSets.some((set) => set.has(id))).length;
}

function masteryStatus(score) {
  if (score >= 82) return { label: "掌握稳定", tone: "good", summary: "这个 Deck 的已学比例较高，失败和到期压力都比较低。" };
  if (score >= 64) return { label: "整体可控", tone: "ok", summary: "这个 Deck 已有一定掌握度，但近期到期或失败卡片需要持续处理。" };
  if (score >= 42) return { label: "掌握偏弱", tone: "warn", summary: "这个 Deck 还有明显的新卡、到期卡或失败卡片堆积。" };
  return { label: "需要集中处理", tone: "risk", summary: "这个 Deck 的学习覆盖或稳定性较低，建议先处理新卡和失败卡。" };
}

function buildDeckStats({ deckName, allIds, newIds, dueNowIds, dueSoonIds, failedIds, multiFailedIds, sampleInfos }) {
  const total = allIds.length;
  const newSet = new Set(newIds);
  const dueNowSet = new Set(dueNowIds);
  const dueSoonSet = new Set(dueSoonIds);
  const failedSet = new Set(failedIds);
  const learned = Math.max(total - newSet.size, 0);
  const dueWithinThreeOnly = countOutside(dueSoonIds, [dueNowSet]);
  const stable = countOutside(allIds, [newSet, dueSoonSet, failedSet]);
  const learnedRatio = total ? learned / total : 0;
  const failurePressure = learned ? failedSet.size / learned : 0;
  const duePressure = learned ? dueSoonSet.size / learned : 0;
  const score = total
    ? Math.round(clamp((learnedRatio * 0.58 + (1 - clamp(failurePressure, 0, 1)) * 0.26 + (1 - clamp(duePressure, 0, 1)) * 0.16) * 100, 0, 100))
    : 0;
  const status = masteryStatus(score);
  const infoById = new Map(sampleInfos.map((card) => [card.cardId, card]));

  return {
    deckName,
    generatedAt: new Date().toLocaleString(),
    score,
    status,
    counts: {
      total,
      learned,
      new: newSet.size,
      dueNow: dueNowSet.size,
      dueSoon: dueSoonSet.size,
      dueWithinThreeOnly,
      failed: failedSet.size,
      multiFailed: multiFailedIds.length,
      stable,
    },
    charts: {
      mastery: [
        { label: "稳定已学", value: stable, color: "#176b55" },
        { label: "还没学过", value: newSet.size, color: "#64748b" },
        { label: "3 天内到期", value: countOutside(dueSoonIds, [dueNowSet, failedSet]), color: "#d97706" },
        { label: "有失败记录", value: failedSet.size, color: "#b91c1c" },
      ],
      due: [
        { label: "已到期", value: dueNowSet.size, color: "#b91c1c" },
        { label: "3 天内", value: dueWithinThreeOnly, color: "#d97706" },
        { label: "未到期已学", value: Math.max(learned - dueSoonSet.size, 0), color: "#176b55" },
        { label: "未学习", value: newSet.size, color: "#64748b" },
      ],
    },
    samples: {
      new: newIds.map((id) => infoById.get(id)).filter(Boolean),
      dueSoon: uniqueValues([...dueNowIds, ...dueSoonIds]).map((id) => infoById.get(id)).filter(Boolean),
      failed: failedIds.map((id) => infoById.get(id)).filter(Boolean),
      multiFailed: multiFailedIds.map((id) => infoById.get(id)).filter(Boolean),
    },
  };
}

function todayISO() {
  const now = new Date();
  const offsetMs = now.getTimezoneOffset() * 60 * 1000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10);
}

function buildOmniFocusPlan(deckStats) {
  if (!deckStats) return null;
  const dueDate = todayISO();
  const dueNow = deckStats.counts.dueNow;
  const dueSoon = deckStats.counts.dueSoon;
  const targetCount = dueNow || dueSoon;
  const label = dueNow ? "due now" : "due within 3d";
  const title = targetCount
    ? `Anki: ${deckStats.deckName} - ${targetCount} ${label}`
    : `Anki: ${deckStats.deckName} - clear`;

  return {
    key: `deck:${deckStats.deckName}:${dueDate}`,
    projectName: "Anki",
    tagName: "anki",
    deckName: deckStats.deckName,
    title,
    dueDate,
    dueNow,
    dueSoon,
    score: deckStats.score,
    shouldComplete: targetCount === 0,
    estimateMinutes: targetCount ? clamp(targetCount, 5, 120) : 0,
    flagged: targetCount > 0,
  };
}

function formatEstimateMinutes(minutes) {
  if (!minutes) return "-";
  return minutes >= 60 ? `${Math.round(minutes / 60)}h` : `${minutes}m`;
}

async function omniFocusBridgeRequest(path, payload) {
  const response = await fetch(`${OMNIFOCUS_BRIDGE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(data.error || `Bridge HTTP ${response.status}`);
  return data;
}

function buildExportText(cards) {
  const hasCloze = cards.some((card) => card.modelName === "Cloze");
  const hasBasic = cards.some((card) => card.modelName !== "Cloze");
  const headers = [
    "#separator:tab",
    "#html:true",
    "#columns:Deck\tNotetype\tFront\tBack\tText\tExtra\tTags",
  ];

  if (hasCloze && !hasBasic) headers.push("#notetype:Cloze");
  if (hasBasic && !hasCloze) headers.push("#notetype:Basic");

  const body = cards.map((card) => [
    card.deckName || "Default",
    card.modelName || "Basic",
    card.modelName === "Cloze" ? "" : card.front,
    card.modelName === "Cloze" ? "" : card.back,
    card.modelName === "Cloze" ? card.text : "",
    card.modelName === "Cloze" ? card.extra : "",
    normalizeTags(card.tags).join(" "),
  ].map((cell) => stringifyCell(cell, "\t")).join("\t"));

  return [...headers, ...body].join("\n");
}

function downloadText(filename, content) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function ankiRequest(action, params = {}) {
  const response = await fetch(ANKI_CONNECT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, version: 6, params }),
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

function toAnkiNote(card, modelConfig, modelFields) {
  const kind = cardModelKind(card);
  const modelName = modelConfig[kind] || card.modelName || defaultModelConfig[kind];
  return {
    deckName: card.deckName || "Default",
    modelName,
    fields: fieldsForCard(card, modelName, modelFields),
    options: { allowDuplicate: false, duplicateScope: "deck" },
    tags: normalizeTags(card.tags),
  };
}

function App() {
  const saved = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    } catch {
      return {};
    }
  }, []);

  const initialPage = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("page") === "stats"
    ? "stats"
    : saved.activePage || "cards";
  const [activePage, setActivePage] = useState(initialPage);
  const [cards, setCards] = useState(saved.cards || []);
  const [draft, setDraft] = useState(saved.draft || initialDraft);
  const [importText, setImportText] = useState(saved.importText || sampleImport);
  const [selectedIds, setSelectedIds] = useState(new Set(saved.cards?.map((card) => card.id) || []));
  const [editingId, setEditingId] = useState(null);
  const [status, setStatus] = useState("本地就绪");
  const [ankiState, setAnkiState] = useState({ decks: [], models: [], connected: false });
  const [modelConfig, setModelConfig] = useState(saved.modelConfig || defaultModelConfig);
  const [modelFields, setModelFields] = useState(saved.modelFields || {});
  const [browserQuery, setBrowserQuery] = useState(saved.browserQuery || "deck:*");
  const [browserLimit, setBrowserLimit] = useState(saved.browserLimit || 50);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [existingCards, setExistingCards] = useState([]);
  const [existingTotal, setExistingTotal] = useState(0);
  const [statsDeck, setStatsDeck] = useState(saved.statsDeck || saved.draft?.deckName || "Default");
  const [statsLoading, setStatsLoading] = useState(false);
  const [deckStats, setDeckStats] = useState(saved.deckStats || null);
  const [omniFocusSync, setOmniFocusSync] = useState(saved.omniFocusSync || {});
  const [omniFocusLoading, setOmniFocusLoading] = useState(false);
  const analysis = useMemo(() => analyzeAnkiText(importText), [importText]);
  const selectedCards = cards.filter((card) => selectedIds.has(card.id));
  const exportPreview = useMemo(() => buildExportText(selectedCards.length ? selectedCards : cards), [cards, selectedCards]);
  const omniFocusPlan = useMemo(() => buildOmniFocusPlan(deckStats), [deckStats]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      activePage,
      cards,
      draft,
      importText,
      browserQuery,
      browserLimit,
      modelConfig,
      modelFields,
      statsDeck,
      deckStats,
      omniFocusSync,
    }));
  }, [activePage, cards, draft, importText, browserQuery, browserLimit, modelConfig, modelFields, statsDeck, deckStats, omniFocusSync]);

  function updateDraft(key, value) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function addOrUpdateCard() {
    const cleanDraft = {
      ...draft,
      deckName: draft.deckName.trim() || "Default",
      tags: normalizeTags(draft.tags).join(" "),
    };

    const invalidBasic = cleanDraft.modelName !== "Cloze" && (!cleanDraft.front.trim() || !cleanDraft.back.trim());
    const invalidCloze = cleanDraft.modelName === "Cloze" && !/\{\{c\d+::.+?\}\}/.test(cleanDraft.text);
    if (invalidBasic) {
      setStatus("基础卡片需要填写正面和背面。");
      return;
    }
    if (invalidCloze) {
      setStatus("Cloze 卡片需要包含形如 {{c1::内容}} 的完形标记。");
      return;
    }

    const duplicateInList = cards.some((card) => card.id !== editingId && cardDuplicateKey(card) === cardDuplicateKey(cleanDraft));
    if (duplicateInList) {
      setStatus("发现重复内容，未加入本地列表。");
      return;
    }

    if (editingId) {
      setCards((current) => current.map((card) => (card.id === editingId ? { ...cleanDraft, id: editingId, source: "manual" } : card)));
      setStatus("已更新本地卡片。");
      setEditingId(null);
      return;
    }

    const nextCard = { ...cleanDraft, id: uid(), source: "manual" };
    setCards((current) => [nextCard, ...current]);
    setSelectedIds((current) => new Set([...current, nextCard.id]));
    setStatus("已生成 1 张本地卡片。");
  }

  function editCard(card) {
    setDraft({
      deckName: card.deckName || "Default",
      modelName: card.modelName || "Basic",
      front: card.front || "",
      back: card.back || "",
      text: card.text || "",
      extra: card.extra || "",
      tags: normalizeTags(card.tags).join(" "),
    });
    setEditingId(card.id);
    setStatus("正在编辑所选卡片。");
  }

  function removeCard(id) {
    setCards((current) => current.filter((card) => card.id !== id));
    setSelectedIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }

  function importRecognizedCards() {
    if (!analysis.notes.length) {
      setStatus("没有可导入的识别结果。");
      return;
    }
    const { unique, duplicateCount } = dedupeCards(analysis.notes, cards);
    if (!unique.length) {
      setStatus(`识别到 ${analysis.notes.length} 张，但全部是重复内容，未加入本地列表。`);
      return;
    }
    setCards((current) => [...unique, ...current]);
    setSelectedIds(new Set(unique.map((note) => note.id)));
    setStatus(`已加入 ${unique.length} 张本地卡片，去掉重复 ${duplicateCount} 张。`);
  }

  function toggleSelected(id) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setSelectedIds(new Set(cards.map((card) => card.id)));
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  function clearLocalCards() {
    setCards([]);
    setSelectedIds(new Set());
    setEditingId(null);
    setStatus("已清空本地卡片列表。");
  }

  async function copyExportText() {
    await navigator.clipboard.writeText(exportPreview);
    setStatus("已复制 Anki 文本导入内容。");
  }

  async function loadImportFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setImportText(text);
    setStatus(`已读取 ${file.name}。`);
    event.target.value = "";
  }

  async function loadModelFields(modelNames) {
    const uniqueNames = [...new Set(modelNames.filter(Boolean))];
    const entries = await Promise.all(uniqueNames.map(async (modelName) => {
      try {
        const fields = await ankiRequest("modelFieldNames", { modelName });
        return [modelName, fields];
      } catch {
        return [modelName, []];
      }
    }));
    const nextFields = Object.fromEntries(entries);
    setModelFields((current) => ({ ...current, ...nextFields }));
    return nextFields;
  }

  async function refreshAnkiMetadata() {
    const [version, decks, models] = await Promise.all([
      ankiRequest("version"),
      ankiRequest("deckNames"),
      ankiRequest("modelNames"),
    ]);
    const nextConfig = resolveModelConfig(models, modelConfig);
    const nextFields = await loadModelFields(Object.values(nextConfig));
    setAnkiState({ decks, models, connected: true });
    setModelConfig(nextConfig);
    return { version, decks, models, modelConfig: nextConfig, modelFields: { ...modelFields, ...nextFields } };
  }

  async function testAnki() {
    try {
      const metadata = await refreshAnkiMetadata();
      setStatus(`已连接 AnkiConnect v${metadata.version}，已读取 ${metadata.models.length} 个笔记类型。`);
    } catch (error) {
      setAnkiState((current) => ({ ...current, connected: false }));
      setStatus(`连接失败：${error.message}。请确认 Anki 已打开并安装 AnkiConnect。`);
    }
  }

  async function fetchExistingCards() {
    const query = browserQuery.trim() || "deck:*";
    const limit = Math.max(1, Math.min(Number(browserLimit) || 50, 500));
    setBrowserLoading(true);

    try {
      const cardIds = await ankiRequest("findCards", { query });
      const limitedIds = cardIds.slice(0, limit);
      const cardInfos = limitedIds.length ? await ankiRequest("cardsInfo", { cards: limitedIds }) : [];
      setExistingCards(cardInfos);
      setExistingTotal(cardIds.length);
      setAnkiState((current) => ({ ...current, connected: true }));
      setStatus(`已读取 Anki 现有卡片 ${cardInfos.length}/${cardIds.length} 张。`);
    } catch (error) {
      setAnkiState((current) => ({ ...current, connected: false }));
      setStatus(`读取现有卡片失败：${error.message}`);
    } finally {
      setBrowserLoading(false);
    }
  }

  async function pushToAnki() {
    const targetCards = selectedCards.length ? selectedCards : cards;
    if (!targetCards.length) {
      setStatus("没有可发送的卡片。");
      return;
    }

    try {
      const metadata = ankiState.models.length
        ? {
          models: ankiState.models,
          modelConfig,
          modelFields: { ...modelFields, ...await loadModelFields(Object.values(modelConfig)) },
        }
        : await refreshAnkiMetadata();
      const notes = targetCards.map((card) => toAnkiNote(card, metadata.modelConfig, metadata.modelFields));
      const missingModels = [...new Set(notes.map((note) => note.modelName).filter((modelName) => !ankiState.models.includes(modelName) && !metadata.models?.includes(modelName)))];
      if (missingModels.length) {
        setStatus(`发送前需要选择 Anki 中存在的笔记类型：${missingModels.join(", ")}`);
        return;
      }

      const batchDedupe = dedupeNotes(notes);
      if (!batchDedupe.unique.length) {
        setStatus(`准备发送的 ${notes.length} 张全部是重复内容，未创建新卡片。`);
        return;
      }

      const canAdd = await ankiRequest("canAddNotes", { notes: batchDedupe.unique });
      const addableNotes = batchDedupe.unique.filter((_, index) => canAdd[index]);
      const ankiDuplicateCount = batchDedupe.unique.length - addableNotes.length;
      if (!addableNotes.length) {
        setStatus(`准备发送的 ${notes.length} 张没有可创建项；批内重复 ${batchDedupe.duplicateCount} 张，Anki 已存在或不可新增 ${ankiDuplicateCount} 张。`);
        return;
      }

      const result = await ankiRequest("addNotes", { notes: addableNotes });
      const added = result.filter(Boolean).length;
      setStatus(`已创建 ${added} 张；发送前去掉批内重复 ${batchDedupe.duplicateCount} 张，跳过 Anki 已存在或不可新增 ${ankiDuplicateCount} 张。`);
    } catch (error) {
      setStatus(`发送失败：${error.message}`);
    }
  }

  async function loadDeckStats() {
    const deckName = statsDeck.trim();
    if (!deckName) {
      setStatus("请先选择或输入一个 Deck。");
      return;
    }

    setStatsLoading(true);
    try {
      if (!ankiState.decks.length) await refreshAnkiMetadata();
      const query = deckSearchQuery(deckName);
      const [allIds, newIds, dueNowIds, dueSoonIds, failedIds, multiFailedIds] = await Promise.all([
        ankiRequest("findCards", { query }),
        ankiRequest("findCards", { query: `${query} is:new` }),
        ankiRequest("findCards", { query: `${query} -is:new is:due` }),
        ankiRequest("findCards", { query: `${query} -is:new prop:due<=3` }),
        ankiRequest("findCards", { query: `${query} prop:lapses>0` }),
        ankiRequest("findCards", { query: `${query} prop:lapses>1` }),
      ]);
      const sampleIds = uniqueValues([
        ...newIds.slice(0, 12),
        ...dueNowIds.slice(0, 12),
        ...dueSoonIds.slice(0, 12),
        ...failedIds.slice(0, 16),
        ...multiFailedIds.slice(0, 12),
      ]);
      const sampleInfos = sampleIds.length ? await ankiRequest("cardsInfo", { cards: sampleIds }) : [];
      const nextStats = buildDeckStats({ deckName, allIds, newIds, dueNowIds, dueSoonIds, failedIds, multiFailedIds, sampleInfos });
      setDeckStats(nextStats);
      setStatus(`已统计 ${deckName}：共 ${nextStats.counts.total} 张卡片。`);
    } catch (error) {
      setStatus(`Deck 统计失败：${error.message}`);
    } finally {
      setStatsLoading(false);
    }
  }

  async function syncDeckToOmniFocus() {
    if (!omniFocusPlan) {
      setStatus("请先生成 Deck 统计，再同步到 OmniFocus。");
      return;
    }

    setOmniFocusLoading(true);
    try {
      const result = await omniFocusBridgeRequest("/sync", { plan: omniFocusPlan });
      setOmniFocusSync((current) => ({
        ...current,
        [omniFocusPlan.key]: {
          ...result.sync,
          plan: omniFocusPlan,
          syncedAt: new Date().toLocaleString(),
          bridgeUrl: OMNIFOCUS_BRIDGE_URL,
        },
      }));
      setStatus(result.message || "已同步到 OmniFocus。");
    } catch (error) {
      setOmniFocusSync((current) => ({
        ...current,
        [omniFocusPlan.key]: {
          plan: omniFocusPlan,
          syncedAt: new Date().toLocaleString(),
          status: "bridge-unavailable",
          error: error.message,
        },
      }));
      setStatus(`OmniFocus 同步未执行：${error.message}。请先启动本地 bridge。`);
    } finally {
      setOmniFocusLoading(false);
    }
  }

  return (
    <main className="app-shell">
      <section className="topbar">
        <div className="brand-lockup">
          <div className="app-mark">
            <Icon name="gallery-vertical-end" size={24} />
          </div>
          <div>
            <p className="eyebrow">Anki Workflow</p>
            <h1>Anki Card Studio</h1>
          </div>
        </div>
        <div className="topbar-insights">
          <HeaderStat icon="library" label="本地卡片" value={cards.length} />
          <HeaderStat icon="check-square" label="选中" value={selectedCards.length || cards.length} />
          <HeaderStat icon={ankiState.connected ? "wifi" : "wifi-off"} label="Anki" value={ankiState.connected ? "在线" : "离线"} />
          <div className="status-pill">
            <Icon name={ankiState.connected ? "plug-zap" : "circle-dot"} />
            <span>{status}</span>
          </div>
        </div>
      </section>

      <nav className="page-tabs" aria-label="页面切换">
        <button type="button" className={activePage === "cards" ? "active" : ""} onClick={() => setActivePage("cards")}>
          <Icon name="square-pen" />
          制卡工具
        </button>
        <button type="button" className={activePage === "stats" ? "active" : ""} onClick={() => setActivePage("stats")}>
          <Icon name="chart-column" />
          Deck 统计
        </button>
      </nav>

      {activePage === "cards" ? (
        <>
      <section className="workspace">
        <section className="panel editor-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Create</p>
              <h2>生成本地卡片</h2>
            </div>
            <div className="segmented">
              {["Basic", "Basic (and reversed card)", "Cloze"].map((model) => (
                <button
                  key={model}
                  className={draft.modelName === model ? "active" : ""}
                  onClick={() => updateDraft("modelName", model)}
                  type="button"
                >
                  {model === "Basic (and reversed card)" ? "双向" : model}
                </button>
              ))}
            </div>
          </div>

          <div className="field-grid">
            <label>
              <span>Deck</span>
              <input value={draft.deckName} onChange={(event) => updateDraft("deckName", event.target.value)} list="deck-list" />
            </label>
            <label>
              <span>Tags</span>
              <input value={draft.tags} onChange={(event) => updateDraft("tags", event.target.value)} placeholder="space separated" />
            </label>
          </div>

          {draft.modelName === "Cloze" ? (
            <>
              <label>
                <span>Text</span>
                <textarea value={draft.text} onChange={(event) => updateDraft("text", event.target.value)} rows="6" />
              </label>
              <label>
                <span>Extra</span>
                <textarea value={draft.extra} onChange={(event) => updateDraft("extra", event.target.value)} rows="4" />
              </label>
            </>
          ) : (
            <div className="card-fields">
              <label>
                <span>Front</span>
                <textarea value={draft.front} onChange={(event) => updateDraft("front", event.target.value)} rows="6" />
              </label>
              <label>
                <span>Back</span>
                <textarea value={draft.back} onChange={(event) => updateDraft("back", event.target.value)} rows="6" />
              </label>
            </div>
          )}

          <div className="button-row">
            <button className="primary" type="button" onClick={addOrUpdateCard}>
              <Icon name={editingId ? "save" : "plus"} />
              {editingId ? "更新卡片" : "加入本地列表"}
            </button>
            <button type="button" onClick={() => downloadText("anki-cards.txt", exportPreview)}>
              <Icon name="download" />
              下载 TXT
            </button>
            <button type="button" onClick={copyExportText}>
              <Icon name="copy" />
              复制导入文本
            </button>
          </div>
        </section>

        <section className="panel import-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Recognize</p>
              <h2>识别 Anki 文本格式</h2>
            </div>
            <div className="button-row compact">
              <label className="file-picker">
                <Icon name="upload" />
                读取文件
                <input type="file" accept=".txt,.csv,.tsv,text/plain,text/csv" onChange={loadImportFile} />
              </label>
              <button type="button" onClick={importRecognizedCards}>
                <Icon name="file-input" />
                加入列表
              </button>
            </div>
          </div>
          <textarea
            className="import-box"
            value={importText}
            onChange={(event) => setImportText(event.target.value)}
            rows="12"
            spellCheck="false"
          />
          <div className="analysis-grid">
            <Metric label="格式" value={analysis.format} />
            <Metric label="分隔符" value={separatorLabel(analysis.separator)} />
            <Metric label="字段" value={analysis.columns.length} />
            <Metric label="卡片" value={analysis.rowCount} />
          </div>
          <div className="detected-columns">
            {analysis.columns.map((column) => <span key={column}>{column}</span>)}
          </div>
          {analysis.warnings.length > 0 && (
            <div className="warning-box">
              {analysis.warnings.map((warning) => <p key={warning}>{warning}</p>)}
            </div>
          )}
        </section>
      </section>

      <section className="lower-grid">
        <section className="panel list-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Library</p>
              <h2>本地卡片列表</h2>
            </div>
            <div className="button-row compact">
              <button type="button" onClick={selectAll}><Icon name="list-checks" />全选</button>
              <button type="button" onClick={clearSelection}><Icon name="x" />清空</button>
              <button type="button" className="danger-button" onClick={clearLocalCards}><Icon name="trash-2" />清空列表</button>
            </div>
          </div>
          <div className="table">
            {cards.length === 0 ? (
              <div className="empty-state">还没有本地卡片。可以手动创建，或从右侧识别结果加入。</div>
            ) : cards.map((card) => (
              <article className="card-row" key={card.id}>
                <input type="checkbox" checked={selectedIds.has(card.id)} onChange={() => toggleSelected(card.id)} aria-label="选择卡片" />
                <div className="card-main">
                  <div className="card-meta">
                    <span>{card.deckName}</span>
                    <span>{card.modelName}</span>
                    <span>{normalizeTags(card.tags).join(" ") || "no tags"}</span>
                  </div>
                  <h3>{cardTitle(card) || "Untitled"}</h3>
                  <p>{cardAnswer(card) || "No answer/extra"}</p>
                </div>
                <div className="row-actions">
                  <button type="button" onClick={() => editCard(card)} title="编辑"><Icon name="pencil" /></button>
                  <button type="button" onClick={() => removeCard(card.id)} title="删除"><Icon name="trash-2" /></button>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="panel anki-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Sync</p>
              <h2>AnkiConnect</h2>
            </div>
            <button type="button" onClick={testAnki}>
              <Icon name="refresh-cw" />
              检测
            </button>
          </div>
          <p className="helper-text">
            发送前请打开桌面版 Anki，并启用 AnkiConnect。默认接口为 <code>{ANKI_CONNECT_URL}</code>。
          </p>
          <div className="model-mapping-grid">
            <ModelSelect
              label="基础卡模板"
              value={modelConfig.basic}
              models={ankiState.models}
              fields={modelFields[modelConfig.basic]}
              onChange={(value) => {
                setModelConfig((current) => ({ ...current, basic: value }));
                loadModelFields([value]);
              }}
            />
            <ModelSelect
              label="双向卡模板"
              value={modelConfig.reversed}
              models={ankiState.models}
              fields={modelFields[modelConfig.reversed]}
              onChange={(value) => {
                setModelConfig((current) => ({ ...current, reversed: value }));
                loadModelFields([value]);
              }}
            />
            <ModelSelect
              label="Cloze 模板"
              value={modelConfig.cloze}
              models={ankiState.models}
              fields={modelFields[modelConfig.cloze]}
              onChange={(value) => {
                setModelConfig((current) => ({ ...current, cloze: value }));
                loadModelFields([value]);
              }}
            />
          </div>
          <button className="primary wide" type="button" onClick={pushToAnki}>
            <Icon name="send" />
            发送选中卡片到 Anki
          </button>
          <datalist id="deck-list">
            {ankiState.decks.map((deck) => <option value={deck} key={deck} />)}
          </datalist>
          <div className="connection-details">
            <Metric label="Decks" value={ankiState.decks.length || "-"} />
            <Metric label="Models" value={ankiState.models.length || "-"} />
            <Metric label="Selected" value={selectedCards.length || cards.length} />
          </div>
          <label>
            <span>导出预览</span>
            <textarea className="preview-box" value={exportPreview} readOnly rows="9" spellCheck="false" />
          </label>
        </section>
      </section>

      <section className="panel existing-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Browse</p>
            <h2>Anki 现有卡片</h2>
          </div>
          <div className="button-row compact">
            <button type="button" onClick={testAnki}>
              <Icon name="plug" />
              读取 Deck
            </button>
            <button className="primary" type="button" onClick={fetchExistingCards} disabled={browserLoading}>
              <Icon name={browserLoading ? "loader-circle" : "search"} />
              {browserLoading ? "读取中" : "查询卡片"}
            </button>
          </div>
        </div>

        <div className="browser-controls">
          <label>
            <span>Anki 搜索查询</span>
            <input
              value={browserQuery}
              onChange={(event) => setBrowserQuery(event.target.value)}
              placeholder='deck:"Default" tag:marked'
            />
          </label>
          <label>
            <span>最多显示</span>
            <input
              type="number"
              min="1"
              max="500"
              value={browserLimit}
              onChange={(event) => setBrowserLimit(event.target.value)}
            />
          </label>
        </div>

        {ankiState.decks.length > 0 && (
          <div className="deck-filter">
            {ankiState.decks.map((deck) => (
              <button type="button" key={deck} onClick={() => setBrowserQuery(deckSearchQuery(deck))}>
                <Icon name="layers" size={16} />
                {deck}
              </button>
            ))}
          </div>
        )}

        <div className="browse-summary">
          <Metric label="Matched" value={existingTotal || "-"} />
          <Metric label="Showing" value={existingCards.length || "-"} />
          <Metric label="Query" value={browserQuery || "deck:*"} />
        </div>

        <div className="existing-card-grid">
          {existingCards.length === 0 ? (
            <div className="empty-state">还没有读取到 Anki 现有卡片。先点“读取 Deck”，再按 Deck 或搜索语法查询。</div>
          ) : existingCards.map((card) => {
            const fields = fieldEntries(card.fields);
            return (
              <article className="existing-card" key={card.cardId}>
                <div className="card-meta">
                  <span>{card.deckName}</span>
                  <span>{card.modelName}</span>
                  <span>{card.cardId}</span>
                </div>
                <h3>{stripHtml(card.question) || fields[0]?.value || "Untitled card"}</h3>
                <p>{stripHtml(card.answer) || fields[1]?.value || "No answer"}</p>
                {fields.length > 0 && (
                  <div className="field-list">
                    {fields.map((field) => (
                      <div key={field.name}>
                        <span>{field.name}</span>
                        <strong>{field.value || "-"}</strong>
                      </div>
                    ))}
                  </div>
                )}
                {normalizeTags(card.tags).length > 0 && (
                  <div className="tag-line">{normalizeTags(card.tags).map((tag) => <span key={tag}>{tag}</span>)}</div>
                )}
              </article>
            );
          })}
        </div>
      </section>
        </>
      ) : (
        <DeckStatsPage
          decks={ankiState.decks}
          statsDeck={statsDeck}
          setStatsDeck={setStatsDeck}
          deckStats={deckStats}
          statsLoading={statsLoading}
          omniFocusPlan={omniFocusPlan}
          omniFocusSync={omniFocusSync}
          omniFocusLoading={omniFocusLoading}
          onLoad={loadDeckStats}
          onRefreshDecks={testAnki}
          onSyncOmniFocus={syncDeckToOmniFocus}
        />
      )}
    </main>
  );
}

function Metric({ label, value }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function HeaderStat({ icon, label, value }) {
  return (
    <div className="header-stat">
      <Icon name={icon} size={16} />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ModelSelect({ label, value, models, fields = [], onChange }) {
  return (
    <label className="model-select">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {!models.includes(value) && <option value={value}>{value}</option>}
        {models.map((model) => <option value={model} key={model}>{model}</option>)}
      </select>
      <small>{fields.length ? `字段：${fields.join(" / ")}` : "点击检测后读取字段"}</small>
    </label>
  );
}

function DeckStatsPage({ decks, statsDeck, setStatsDeck, deckStats, statsLoading, omniFocusPlan, omniFocusSync, omniFocusLoading, onLoad, onRefreshDecks, onSyncOmniFocus }) {
  const currentSync = omniFocusPlan ? omniFocusSync[omniFocusPlan.key] : null;

  return (
    <section className="stats-page">
      <section className="panel stats-controls-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Deck Insight</p>
            <h2>Deck 掌握程度和到期时间</h2>
          </div>
          <div className="button-row compact">
            <button type="button" onClick={onRefreshDecks}>
              <Icon name="refresh-cw" />
              读取 Deck
            </button>
            <button className="primary" type="button" onClick={onLoad} disabled={statsLoading}>
              <Icon name={statsLoading ? "loader-circle" : "activity"} />
              {statsLoading ? "统计中" : "生成统计"}
            </button>
          </div>
        </div>
        <div className="stats-controls">
          <label>
            <span>Deck</span>
            <input value={statsDeck} onChange={(event) => setStatsDeck(event.target.value)} list="stats-deck-list" />
          </label>
          <datalist id="stats-deck-list">
            {decks.map((deck) => <option value={deck} key={deck} />)}
          </datalist>
        </div>
        {decks.length > 0 && (
          <div className="deck-filter">
            {decks.map((deck) => (
              <button type="button" key={deck} onClick={() => setStatsDeck(deck)}>
                <Icon name="layers" size={16} />
                {deck}
              </button>
            ))}
          </div>
        )}
      </section>

      {!deckStats ? (
        <section className="panel">
          <div className="empty-state">选择一个 Deck 后生成统计。页面会显示未学、近期到期、失败记录和整体掌握状态。</div>
        </section>
      ) : (
        <>
          <section className={`panel mastery-hero ${deckStats.status.tone}`}>
            <div>
              <p className="eyebrow">Overall</p>
              <h2>{deckStats.deckName}</h2>
              <p className="helper-text">{deckStats.status.summary}</p>
              <small>统计时间：{deckStats.generatedAt}</small>
            </div>
            <div className="score-ring" style={{ "--score": `${deckStats.score}%` }}>
              <strong>{deckStats.score}</strong>
              <span>{deckStats.status.label}</span>
            </div>
          </section>

          <section className="stats-metric-grid">
            <Metric label="Total" value={deckStats.counts.total} />
            <Metric label="Learned" value={deckStats.counts.learned} />
            <Metric label="New" value={deckStats.counts.new} />
            <Metric label="Due Now" value={deckStats.counts.dueNow} />
            <Metric label="Due <= 3d" value={deckStats.counts.dueSoon} />
            <Metric label="Lapses > 0" value={deckStats.counts.failed} />
            <Metric label="Lapses > 1" value={deckStats.counts.multiFailed} />
            <Metric label="Stable" value={deckStats.counts.stable} />
          </section>

          <OmniFocusSyncPanel
            plan={omniFocusPlan}
            sync={currentSync}
            loading={omniFocusLoading}
            onSync={onSyncOmniFocus}
          />

          <section className="stats-chart-grid">
            <section className="panel">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Mastery</p>
                  <h2>掌握结构</h2>
                </div>
              </div>
              <StackedBar items={deckStats.charts.mastery} total={deckStats.counts.total} />
              <ChartLegend items={deckStats.charts.mastery} total={deckStats.counts.total} />
            </section>

            <section className="panel">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Due</p>
                  <h2>到期压力</h2>
                </div>
              </div>
              <StackedBar items={deckStats.charts.due} total={deckStats.counts.total} />
              <ChartLegend items={deckStats.charts.due} total={deckStats.counts.total} />
            </section>
          </section>

          <section className="stats-card-lists">
            <StatsCardList title="还没学过的内容" icon="circle-plus" cards={deckStats.samples.new} emptyText="这个 Deck 没有取样到新卡。" />
            <StatsCardList title="已学且快要到期" icon="clock-3" cards={deckStats.samples.dueSoon} emptyText="这个 Deck 近期到期压力较低。" />
            <StatsCardList title="没有通过或多次没通过" icon="circle-alert" cards={deckStats.samples.failed} emptyText="这个 Deck 没有取样到失败记录。" />
            <StatsCardList title="多次没通过" icon="badge-alert" cards={deckStats.samples.multiFailed} emptyText="没有取样到多次失败卡片。" />
          </section>
        </>
      )}
    </section>
  );
}

function OmniFocusSyncPanel({ plan, sync, loading, onSync }) {
  if (!plan) return null;
  const commandPreview = plan.shouldComplete
    ? `of task update <existing-task-id> --complete`
    : [
      `of project create "${plan.projectName}" --sequential --note "Managed by Anki Card Studio"`,
      `of tag create "${plan.tagName}"`,
      `of task create "${plan.title}" --project "${plan.projectName}" --due ${plan.dueDate} --estimate ${plan.estimateMinutes}${plan.flagged ? " --flagged" : ""}`,
    ].join("\n");
  const statusLabel = sync?.status === "synced"
    ? "已同步"
    : sync?.status === "completed"
      ? "已完成"
      : sync?.status === "bridge-unavailable"
        ? "等待 bridge"
        : "未同步";

  return (
    <section className="panel omnifocus-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">OmniFocus</p>
          <h2>手动同步复习任务</h2>
        </div>
        <button className="primary" type="button" onClick={onSync} disabled={loading}>
          <Icon name={loading ? "loader-circle" : "send-to-back"} />
          {loading ? "同步中" : "同步到 OmniFocus"}
        </button>
      </div>

      <div className="sync-summary-grid">
        <Metric label="Task" value={plan.shouldComplete ? "完成今日任务" : plan.title} />
        <Metric label="Due" value={plan.dueDate} />
        <Metric label="Estimate" value={formatEstimateMinutes(plan.estimateMinutes)} />
        <Metric label="Status" value={statusLabel} />
      </div>

      <div className="sync-detail-grid">
        <div>
          <span>触发条件</span>
          <strong>{plan.dueNow} 已到期 / {plan.dueSoon} 三天内到期 / 掌握度 {plan.score}</strong>
        </div>
        <div>
          <span>同步键</span>
          <strong>{plan.key}</strong>
        </div>
      </div>

      <label>
        <span>CLI 预览</span>
        <textarea className="preview-box cli-preview" value={commandPreview} readOnly rows="4" spellCheck="false" />
      </label>

      <p className="helper-text">
        浏览器需要本地 bridge 才能调用 <code>of</code>。启动后这个按钮会创建 Anki 项目和标签，并按当前 Deck 统计生成今日复习任务。
      </p>

      {sync?.error && (
        <div className="warning-box">
          <p>{sync.error}</p>
        </div>
      )}
    </section>
  );
}

function StackedBar({ items, total }) {
  const safeTotal = Math.max(total, 1);
  return (
    <div className="stacked-bar" aria-label="统计条形图">
      {items.filter((item) => item.value > 0).map((item) => (
        <span
          key={item.label}
          style={{ width: `${Math.max((item.value / safeTotal) * 100, 2)}%`, background: item.color }}
          title={`${item.label}: ${item.value}`}
        />
      ))}
    </div>
  );
}

function ChartLegend({ items, total }) {
  const safeTotal = Math.max(total, 1);
  return (
    <div className="chart-legend">
      {items.map((item) => (
        <div key={item.label}>
          <span style={{ background: item.color }} />
          <strong>{item.label}</strong>
          <em>{item.value} / {Math.round((item.value / safeTotal) * 100)}%</em>
        </div>
      ))}
    </div>
  );
}

function StatsCardList({ title, icon, cards, emptyText }) {
  return (
    <section className="panel stats-list-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Cards</p>
          <h2><Icon name={icon} size={18} />{title}</h2>
        </div>
      </div>
      <div className="stats-card-stack">
        {cards.length === 0 ? (
          <div className="empty-state">{emptyText}</div>
        ) : cards.map((card) => {
          const fields = fieldEntries(card.fields);
          return (
            <article className="stats-card" key={`${title}-${card.cardId}`}>
              <div className="card-meta">
                <span>{card.deckName}</span>
                <span>{card.modelName}</span>
                <span>lapses {card.lapses || 0}</span>
                <span>reps {card.reps || 0}</span>
              </div>
              <h3>{stripHtml(card.question) || fields[0]?.value || "Untitled card"}</h3>
              <p>{fields.map((field) => `${field.name}: ${field.value}`).join(" / ") || stripHtml(card.answer) || "No fields"}</p>
            </article>
          );
        })}
      </div>
    </section>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
