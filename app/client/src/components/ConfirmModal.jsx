import React, { useEffect } from "react";
import { IconAlertTriangle, IconInfo, IconX } from "./Icons";

export default function ConfirmModal({
  isOpen,
  title = "操作确认",
  description,
  confirmText = "确认",
  cancelText = "取消",
  confirmType = "danger", // "danger" | "primary"
  isLoading = false,
  onConfirm,
  onCancel,
}) {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === "Escape" && !isLoading) onCancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, isLoading, onCancel]);

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={() => !isLoading && onCancel()}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-header">
          <div className="modal-title-wrap">
            <span className={`modal-icon-badge ${confirmType}`}>
              {confirmType === "danger" ? <IconAlertTriangle size={18} /> : <IconInfo size={18} />}
            </span>
            <h3>{title}</h3>
          </div>
          <button
            type="button"
            className="modal-close-btn"
            onClick={onCancel}
            disabled={isLoading}
            aria-label="关闭"
          >
            <IconX size={16} />
          </button>
        </div>
        <div className="modal-body">
          {typeof description === "string" ? <p>{description}</p> : description}
        </div>
        <div className="modal-footer">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onCancel}
            disabled={isLoading}
          >
            {cancelText}
          </button>
          <button
            type="button"
            className={`btn ${confirmType === "danger" ? "btn-danger" : "btn-primary"}`}
            onClick={onConfirm}
            disabled={isLoading}
          >
            {isLoading ? "处理中…" : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
