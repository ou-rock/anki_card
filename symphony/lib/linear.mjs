import { SymphonyError } from "./errors.mjs";

const ISSUE_FRAGMENT = `
  id
  identifier
  title
  description
  priority
  url
  branchName
  createdAt
  updatedAt
  state { name }
  labels { nodes { name } }
  relations {
    nodes {
      type
      relatedIssue {
        id
        identifier
        state { name }
      }
    }
  }
`;

export class LinearClient {
  constructor(config, logger) {
    this.endpoint = config.tracker.endpoint;
    this.apiKey = config.tracker.api_key;
    this.projectSlug = config.tracker.project_slug;
    this.activeStates = config.tracker.active_states;
    this.terminalStates = config.tracker.terminal_states;
    this.logger = logger;
  }

  async fetchCandidateIssues() {
    return this.fetchIssuesByStates(this.activeStates);
  }

  async fetchTerminalIssues() {
    return this.fetchIssuesByStates(this.terminalStates);
  }

  async fetchIssueStatesByIds(ids) {
    if (!ids.length) return [];
    const query = `
      query SymphonyIssuesByIds($ids: [ID!]) {
        issues(first: 100, filter: { id: { in: $ids } }) {
          nodes { ${ISSUE_FRAGMENT} }
        }
      }
    `;
    const data = await this.graphql(query, { ids });
    return (data.issues?.nodes || []).map(normalizeIssue);
  }

  async fetchIssuesByStates(states) {
    const query = `
      query SymphonyIssuesByProject($projectSlug: String!, $states: [String!]) {
        issues(
          first: 100,
          filter: {
            project: { slugId: { eq: $projectSlug } }
            state: { name: { in: $states } }
          }
        ) {
          nodes { ${ISSUE_FRAGMENT} }
        }
      }
    `;
    const data = await this.graphql(query, { projectSlug: this.projectSlug, states });
    return (data.issues?.nodes || []).map(normalizeIssue);
  }

  async graphql(query, variables) {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Authorization": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.errors?.length) {
      const message = payload?.errors?.map((error) => error.message).join("; ") || `Linear HTTP ${response.status}`;
      throw new SymphonyError("tracker_error", message, { status: response.status });
    }
    return payload.data;
  }
}

export function normalizeIssue(issue) {
  const relations = issue.relations?.nodes || [];
  const blockedBy = relations
    .filter((relation) => String(relation.type || "").toLowerCase().includes("block"))
    .map((relation) => ({
      id: relation.relatedIssue?.id || null,
      identifier: relation.relatedIssue?.identifier || null,
      state: relation.relatedIssue?.state?.name || null,
    }));

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description || null,
    priority: issue.priority ?? null,
    state: issue.state?.name || "",
    branch_name: issue.branchName || null,
    url: issue.url || null,
    labels: (issue.labels?.nodes || []).map((label) => String(label.name).toLowerCase()),
    blocked_by: blockedBy,
    created_at: issue.createdAt || null,
    updated_at: issue.updatedAt || null,
  };
}
