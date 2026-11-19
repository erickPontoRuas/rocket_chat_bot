import type { IssueLevel } from '../../src/flows/issue-report.fields.js';
import { ISSUE_REPORT_FIELDS } from '../../src/flows/issue-report.fields.js';
import type {
  LevelNormalizer,
  ReportAnalyzer,
  ReportIntake,
  TitleGenerator,
} from '../../src/integrations/ai/types.js';

type AnalyzeInput = Parameters<ReportAnalyzer['analyze']>[0];
type TitleInput = Parameters<TitleGenerator['generate']>[0];

export class FakeAnalyzer implements ReportAnalyzer {
  readonly calls: AnalyzeInput[] = [];

  constructor(private readonly handler: ReportAnalyzer['analyze']) {}

  async analyze(input: AnalyzeInput): Promise<ReportIntake> {
    this.calls.push(input);
    return this.handler(input);
  }
}

export class FakeLevelNormalizer implements LevelNormalizer {
  readonly calls: string[] = [];

  constructor(private readonly handler: (answer: string) => Promise<IssueLevel | null>) {}

  async normalize(input: { answer: string }): Promise<IssueLevel | null> {
    this.calls.push(input.answer);
    return this.handler(input.answer);
  }
}

export class FakeTitleGenerator implements TitleGenerator {
  readonly calls: TitleInput[] = [];

  constructor(private readonly handler: TitleGenerator['generate']) {}

  async generate(input: TitleInput): Promise<string> {
    this.calls.push(input);
    return this.handler(input);
  }
}

export function intakeFor(present: Record<string, string>): ReportIntake {
  const values = Object.fromEntries(
    Object.entries(present).filter(([, value]) => value.trim().length > 0),
  );
  const missing = ISSUE_REPORT_FIELDS.filter((field) => !values[field.key]?.trim()).map(
    (field) => field.key,
  );

  return { values, missing };
}

export const ALL_ANSWERS: Record<string, string> = {
  nivel: 'PERDE VENDA',
  atendimentoId: 'ATD-1',
  etapaFunil: 'Checkout',
  clienteDisse: 'Quero finalizar a compra',
  botFez: 'Respondeu que não havia estoque',
  botDeveriaTerFeito: 'Concluir a compra',
  regraNegocio: 'Priorizar a venda',
  jaAconteceuAntes: 'Não',
  print: 'https://chat.exemplo.com/file-upload/print.png',
};
