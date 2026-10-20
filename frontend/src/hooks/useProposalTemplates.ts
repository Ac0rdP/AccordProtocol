import { useCallback, useState } from "react";
import {
  getProposalTemplates,
  saveProposalTemplate,
  renameProposalTemplate,
  deleteProposalTemplate,
  type ProposalTemplateFields,
} from "../lib/proposalTemplates";

export function useProposalTemplates() {
  const [templates, setTemplates] = useState(() => getProposalTemplates());

  const save = useCallback((name: string, fields: ProposalTemplateFields) => {
    saveProposalTemplate(name, fields);
    setTemplates(getProposalTemplates());
  }, []);

  const rename = useCallback((id: string, name: string) => {
    renameProposalTemplate(id, name);
    setTemplates(getProposalTemplates());
  }, []);

  const remove = useCallback((id: string) => {
    deleteProposalTemplate(id);
    setTemplates(getProposalTemplates());
  }, []);

  return { templates, save, rename, remove };
}
