/**
 * Extension point for host resource metrics (CPU / RAM / GPU / disk). Nothing collects them yet:
 * a future Server Monitoring module registers a provider here (reading from an exporter over the
 * network, never via the Docker socket). Until then the overview shows "not collected".
 */
export interface ResourceSample {
  name: 'cpu' | 'ram' | 'gpu' | 'disk';
  label: string;
  value: string;
}

export interface ResourceProvider {
  sample(): Promise<ResourceSample[]>;
}

export const resourceProvider: ResourceProvider | null = null;
