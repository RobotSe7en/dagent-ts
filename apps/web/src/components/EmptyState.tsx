import type { ReactNode } from 'react';

export function EmptyState(props: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{props.icon}</div>
      <h2>{props.title}</h2>
      <p>{props.description}</p>
      {props.action}
    </div>
  );
}
