import { useEffect, useRef, useState } from "react";
import { shortenAddr } from "../lib/soroban";
import { X, ShieldCheck, UserCheck } from "lucide-react";

type RoleModalProps = {
  targetAddress: string;
  targetLabel?: string;
  currentRoles: string[];
  isOpen: boolean;
  onClose: () => void;
  onGrantRole?: (address: string, role: string) => Promise<void>;
  onRevokeRole?: (address: string, role: string) => Promise<void>;
};

const AVAILABLE_ROLES = ["Owner", "Approver", "Admin", "Auditor"];

export function RoleModal({
  targetAddress,
  targetLabel,
  currentRoles = ["Owner", "Approver"],
  isOpen,
  onClose,
  onGrantRole,
  onRevokeRole,
}: RoleModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [selectedRole, setSelectedRole] = useState<string>("Approver");
  const [roles, setRoles] = useState<string[]>(currentRoles);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setRoles(currentRoles);
  }, [currentRoles]);

  // Save focus on open & trap focus inside modal
  useEffect(() => {
    if (!isOpen) return;
    previousFocusRef.current = document.activeElement as HTMLElement;

    const modalElement = modalRef.current;
    if (modalElement) {
      const focusables = modalElement.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length > 0) {
        focusables[0]?.focus();
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Tab" && modalElement) {
        const focusables = Array.from(
          modalElement.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
          )
        ).filter((el) => !el.hasAttribute("disabled"));

        if (focusables.length === 0) return;

        const first = focusables[0];
        const last = focusables[focusables.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      if (previousFocusRef.current && previousFocusRef.current.focus) {
        previousFocusRef.current.focus();
      }
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleGrant = async () => {
    if (!selectedRole || roles.includes(selectedRole)) return;
    setLoading(true);
    setMessage(null);
    try {
      if (onGrantRole) {
        await onGrantRole(targetAddress, selectedRole);
      }
      setRoles((prev) => [...prev, selectedRole]);
      setMessage(`Role ${selectedRole} granted to ${shortenAddr(targetAddress)}`);
    } catch {
      setMessage("Failed to grant role");
    } finally {
      setLoading(false);
    }
  };

  const handleRevoke = async (roleToRevoke: string) => {
    setLoading(true);
    setMessage(null);
    try {
      if (onRevokeRole) {
        await onRevokeRole(targetAddress, roleToRevoke);
      }
      setRoles((prev) => prev.filter((r) => r !== roleToRevoke));
      setMessage(`Role ${roleToRevoke} revoked from ${shortenAddr(targetAddress)}`);
    } catch {
      setMessage("Failed to revoke role");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="role-modal-title"
      aria-describedby="role-modal-desc"
    >
      <div
        ref={modalRef}
        className="w-full max-w-lg overflow-hidden rounded-xl bg-zinc-900 border border-zinc-800 shadow-2xl text-zinc-100"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 bg-zinc-900/50">
          <div className="flex items-center space-x-2">
            <ShieldCheck className="w-5 h-5 text-emerald-400" aria-hidden="true" />
            <h2 id="role-modal-title" className="text-lg font-semibold text-white">
              Manage Roles & Permissions
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close role management modal"
            className="p-1 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-emerald-500 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-6">
          <p id="role-modal-desc" className="text-sm text-zinc-400">
            View and manage RBAC capability assignments for target owner{" "}
            <span className="font-mono text-zinc-200">
              {targetLabel ? `${targetLabel} (${shortenAddr(targetAddress)})` : shortenAddr(targetAddress)}
            </span>
            .
          </p>

          {/* Current Assigned Roles */}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-3">
              Assigned Roles
            </h3>
            <div className="flex flex-wrap gap-2">
              {roles.map((role) => (
                <div
                  key={role}
                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-300 border border-emerald-500/20"
                >
                  <UserCheck className="w-3.5 h-3.5" aria-hidden="true" />
                  <span aria-label={`Role: ${role}`}>{role}</span>
                  {role !== "Owner" && (
                    <button
                      type="button"
                      onClick={() => handleRevoke(role)}
                      disabled={loading}
                      aria-label={`Revoke ${role} role from ${shortenAddr(targetAddress)}`}
                      className="ml-1 text-emerald-400 hover:text-rose-400 focus:outline-none focus:ring-1 focus:ring-rose-500 rounded"
                    >
                      &times;
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Grant New Role Form */}
          <div className="pt-4 border-t border-zinc-800">
            <label htmlFor="grant-role-select" className="block text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2">
              Grant New Role
            </label>
            <div className="flex items-center gap-3">
              <select
                id="grant-role-select"
                value={selectedRole}
                onChange={(e) => setSelectedRole(e.target.value)}
                aria-label="Select role to grant"
                className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                {AVAILABLE_ROLES.map((role) => (
                  <option key={role} value={role} disabled={roles.includes(role)}>
                    {role} {roles.includes(role) ? "(Already granted)" : ""}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={handleGrant}
                disabled={loading || roles.includes(selectedRole)}
                aria-label={`Grant ${selectedRole} role`}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-400"
              >
                Grant Role
              </button>
            </div>
          </div>

          {message && (
            <p role="status" className="text-xs font-medium text-emerald-400">
              {message}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end px-6 py-4 bg-zinc-900/50 border-t border-zinc-800">
          <button
            type="button"
            onClick={onClose}
            aria-label="Done managing roles"
            className="px-4 py-2 text-sm font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-400"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
