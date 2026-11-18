import { Octokit } from '@octokit/rest';
import type { Logger } from 'pino';
import type { CreatedIssue, IssueCreator } from '../../conversation/types.js';
import { IssueCreationError } from '../../utils/errors.js';

interface GitHubIssueCreatorDependencies {
  token: string;
  owner: string;
  repo: string;
  labels: string[];
  logger: Logger;
}

export class GitHubIssueCreator implements IssueCreator {
  private readonly octokit: Octokit;

  constructor(private readonly deps: GitHubIssueCreatorDependencies) {
    this.octokit = new Octokit({ auth: deps.token });
  }

  async createIssue(input: { title: string; body: string }): Promise<CreatedIssue> {
    try {
      const response = await this.octokit.rest.issues.create({
        owner: this.deps.owner,
        repo: this.deps.repo,
        title: input.title,
        body: input.body,
        ...(this.deps.labels.length > 0 ? { labels: this.deps.labels } : {}),
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
