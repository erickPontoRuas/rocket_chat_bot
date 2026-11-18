export class DomainError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ConfigurationError extends DomainError {}

export class IssueCreationError extends DomainError {}
