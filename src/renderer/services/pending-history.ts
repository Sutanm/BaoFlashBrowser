export interface PendingHistoryVisit {
  tabId: string;
  url: string;
  title?: string;
}

/** Keeps navigation history candidates isolated per tab. */
export class PendingHistoryRegistry {
  private readonly visits = new Map<string, PendingHistoryVisit>();

  set(visit: PendingHistoryVisit): void {
    this.visits.set(visit.tabId, visit);
  }

  updateTitle(tabId: string, title: string): void {
    const visit = this.visits.get(tabId);
    if (visit) visit.title = title;
  }

  take(tabId: string): PendingHistoryVisit | null {
    const visit = this.visits.get(tabId) ?? null;
    this.visits.delete(tabId);
    return visit;
  }

  delete(tabId: string): void {
    this.visits.delete(tabId);
  }

  clear(): void {
    this.visits.clear();
  }
}
