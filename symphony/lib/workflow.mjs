import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import YAML from "yaml";
import { Liquid } from "liquidjs";
import { SymphonyError } from "./errors.mjs";

const liquid = new Liquid({
  strictFilters: true,
  strictVariables: true,
});

export async function loadWorkflow(workflowPath = resolve(process.cwd(), "WORKFLOW.md")) {
  let source;
  try {
    source = await readFile(workflowPath, "utf8");
  } catch (error) {
    throw new SymphonyError("missing_workflow_file", `Cannot read workflow file: ${workflowPath}`, { cause: error.message });
  }

  const parsed = parseWorkflowSource(source, workflowPath);
  let mtimeMs = null;
  try {
    mtimeMs = (await stat(workflowPath)).mtimeMs;
  } catch {
    // The file was already read; mtime is only used for reload hints.
  }

  return {
    ...parsed,
    path: resolve(workflowPath),
    dir: dirname(resolve(workflowPath)),
    mtime_ms: mtimeMs,
  };
}

export function parseWorkflowSource(source, workflowPath = "WORKFLOW.md") {
  if (!source.startsWith("---")) {
    return { config: {}, prompt_template: source.trim() };
  }

  const lines = source.split(/\r?\n/);
  let closing = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "---") {
      closing = index;
      break;
    }
  }
  if (closing === -1) {
    throw new SymphonyError("workflow_parse_error", `Workflow front matter is missing a closing --- in ${workflowPath}`);
  }

  const frontMatter = lines.slice(1, closing).join("\n");
  const body = lines.slice(closing + 1).join("\n").trim();
  let config;
  try {
    config = frontMatter.trim() ? YAML.parse(frontMatter) : {};
  } catch (error) {
    throw new SymphonyError("workflow_parse_error", `Cannot parse workflow YAML: ${error.message}`);
  }

  if (config === null) config = {};
  if (typeof config !== "object" || Array.isArray(config)) {
    throw new SymphonyError("workflow_front_matter_not_a_map", "Workflow YAML front matter must decode to an object/map.");
  }

  return { config, prompt_template: body };
}

export async function renderPrompt(promptTemplate, issue, attempt = null) {
  const template = promptTemplate?.trim() || "You are working on an issue from Linear.";
  try {
    return await liquid.parseAndRender(template, { issue, attempt });
  } catch (error) {
    throw new SymphonyError("template_render_error", `Prompt render failed: ${error.message}`);
  }
}
