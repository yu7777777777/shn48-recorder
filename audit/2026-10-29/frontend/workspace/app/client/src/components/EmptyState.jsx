import React from "react";
import { IconArchive, IconLayers } from "./Icons";

export default function EmptyState({ title, detail, action, icon: CustomIcon }) {
  const IconComponent = CustomIcon || IconLayers;
  return (
    <div className="empty-state">
      <div className="empty-mark" aria-hidden="true">
        <IconComponent size={24} />
      </div>
      <h3>{title}</h3>
      {detail && <p>{detail}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}
