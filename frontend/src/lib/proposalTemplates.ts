/**
 * Field values a template can carry. Shared across the proposal and
 * recurring-payment creation modals so a template saved in one is loadable
 * in the other — each modal just reads the fields it understands.
 */
export type ProposalTemplateFields = {
  recipient?: string;
  amount?: string;
  token?: string;
  description?: string;
  category?: string;
  kind?: string;
  interval?: string;
  cliff?: string;
  endDate?: string;
  cap?: string;
};

export type ProposalTemplate = {
  id: string;
  name: string;
  fields: ProposalTemplateFields;
  createdAt: string;
  updatedAt: string;
};

const TEMPLATES_KEY = "accord_proposal_templates";

export function getProposalTemplates(): ProposalTemplate[] {
  try {
    const raw = localStorage.getItem(TEMPLATES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function persist(templates: ProposalTemplate[]): void {
  try {
    localStorage.setItem(TEMPLATES_KEY, JSON.stringify(templates));
  } catch {
    // localStorage might be unavailable or throw in restricted environments
  }
}

export function saveProposalTemplate(name: string, fields: ProposalTemplateFields): ProposalTemplate {
  const now = new Date().toISOString();
  const template: ProposalTemplate = {
    id: `template-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    fields,
    createdAt: now,
    updatedAt: now,
  };
  persist([...getProposalTemplates(), template]);
  return template;
}

export function renameProposalTemplate(id: string, name: string): void {
  persist(
    getProposalTemplates().map((t) =>
      t.id === id ? { ...t, name, updatedAt: new Date().toISOString() } : t
    )
  );
}

export function deleteProposalTemplate(id: string): void {
  persist(getProposalTemplates().filter((t) => t.id !== id));
}
