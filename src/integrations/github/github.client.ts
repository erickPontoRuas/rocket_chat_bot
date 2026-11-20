import { Octokit } from '@octokit/rest';
import type { Logger } from 'pino';
import type { CreatedIssue, IssueCreator } from '../../conversation/types.js';
import { LEVEL_VALUES } from '../../flows/issue-report.fields.js';
import { IssueCreationError } from '../../utils/errors.js';

interface GitHubIssueCreatorDependencies {
  token: string;
  owner: string;
  repo: string;
  labels: string[];
  logger: Logger;
}

const LEVEL_LABEL_KEYS = new Set(LEVEL_VALUES.map((value) => value.toLowerCase()));

export class GitHubIssueCreator implements IssueCreator {
  private readonly octokit: Octokit;

  constructor(private readonly deps: GitHubIssueCreatorDependencies) {
    this.octokit = new Octokit({ auth: deps.token });
  }

  async createIssue(input: {
    title: string;
    body: string;
    labels?: string[];
  }): Promise<CreatedIssue> {
    const requestedLabels = input.labels ?? [];
    const requestedLevelKey = findLevelKey(requestedLabels);
    const ignoredLevelLabels = this.deps.labels.filter((label) => {
      const key = label.trim().toLowerCase();

      return LEVEL_LABEL_KEYS.has(key) && key !== requestedLevelKey;
    });

    if (ignoredLevelLabels.length > 0) {
      this.deps.logger.warn(
        { ignoredLabels: ignoredLevelLabels },
        'Labels de nível em GITHUB_LABELS ignoradas; a label vem do nível informado no atendimento',
      );
    }

    const labels = mergeLabels(this.deps.labels, requestedLabels);

    try {
      const response = await this.octokit.rest.issues.create({
        owner: this.deps.owner,
        repo: this.deps.repo,
        title: input.title,
        body: input.body,
        ...(labels.length > 0 ? { labels } : {}),
      });

      const issue: CreatedIssue = {
        number: response.data.number,
        url: response.data.html_url,
      };

      this.deps.logger.info(
        { issueNumber: issue.number, url: issue.url },
        'Issue criada no GitHub',
      );

      return issue;
    } catch (error) {
      const status =
        typeof error === 'object' && error !== null && 'status' in error
          ? (error as { status?: number }).status
          : undefined;
      const detail = error instanceof Error ? error.message : String(error);

      this.deps.logger.error({ err: error, status }, 'Falha ao criar issue no GitHub');

      throw new IssueCreationError(
        `Falha ao criar issue no GitHub${status ? ` (HTTP ${status})` : ''}: ${detail}`,
        { cause: error },
      );
    }
  }
}

export function mergeLabels(base: string[], extra: string[]): string[] {
  const byKey = new Map<string, string>();

  for (const label of base) {
    const trimmed = label.trim();

    if (!trimmed) {
      continue;
    }

    const key = trimmed.toLowerCase();

    if (LEVEL_LABEL_KEYS.has(key)) {
      continue;
    }

    if (!byKey.has(key)) {
      byKey.set(key, trimmed);
    }
  }

  const requestedLevelKey = findLevelKey(extra);

  for (const label of extra) {
    const trimmed = label.trim();

    if (!trimmed) {
      continue;
    }

    const key = trimmed.toLowerCase();

    if (LEVEL_LABEL_KEYS.has(key) && key !== requestedLevelKey) {
      continue;
    }

    if (!byKey.has(key)) {
      byKey.set(key, trimmed);
    }
  }

  return [...byKey.values()];
}

function findLevelKey(labels: string[]): string | undefined {
  for (const label of labels) {
    const key = label.trim().toLowerCase();

    if (LEVEL_LABEL_KEYS.has(key)) {
      return key;
    }
  }

  return undefined;
}
