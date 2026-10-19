export function useRecurringPayments() {
  return {
    schedules: [],
    loading: false,
    error: null,
    disburse: async () => undefined,
    pause: async () => undefined,
    resume: async () => undefined,
    cancel: async () => undefined,
    refresh: () => undefined,
  };
}
