"use client";

import { useState } from "react";
import { Dialog } from "@/components/Dialog";
import { errorMessage } from "@/lib/api";

interface Props {
  /** e.g. "5.00 XLM"; null keeps the dialog closed. */
  amount: string | null;
  onClose: () => void;
  /** Records the refund; rejects with the API's error. */
  onConfirm: (txHash: string | undefined) => Promise<void>;
}

/** "Mark as refunded": PayLink never sends money, it only records that the merchant did. */
export function RefundDialog({ amount, onClose, onConfirm }: Props) {
  const [tx, setTx] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [badHash, setBadHash] = useState(false);

  const close = () => {
    setTx("");
    setError(null);
    setBadHash(false);
    onClose();
  };

  const confirm = async () => {
    if (busy) return;
    const hash = tx.trim().toLowerCase();
    if (hash !== "" && !/^[0-9a-f]{64}$/.test(hash)) {
      setBadHash(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onConfirm(hash || undefined);
      setTx("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={amount !== null}
      onClose={close}
      title={`Record the ${amount ?? ""} refund`}
      width={480}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={close} disabled={busy} aria-busy={busy}>
            Not yet
          </button>
          <button type="button" className="btn btn-primary" onClick={confirm} disabled={busy} aria-busy={busy}>
            {busy ? "Recording…" : "I've sent it"}
          </button>
        </>
      }
    >
      <span style={{ fontSize: 15, color: "var(--slate)" }}>PayLink can&apos;t send money for you. Send it from your own wallet first, then record it here.</span>
      {error ? (
        <div role="alert" className="alert">
          {error}
        </div>
      ) : null}
      <div className="field">
        <label htmlFor="rtx" className="label">
          Refund transaction hash <span style={{ fontWeight: 500, color: "var(--slate)" }}>(optional)</span>
        </label>
        <input
          id="rtx"
          className={`input mono${badHash ? " invalid" : ""}`}
          value={tx}
          onChange={(e) => {
            setTx(e.target.value);
            setBadHash(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void confirm();
            }
          }}
          placeholder="64-character hash from your wallet"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={badHash}
          style={{ fontSize: 13 }}
        />
        {badHash ? (
          <span role="alert" className="field-error">
            A transaction hash is 64 characters: numbers and the letters a to f. Leave it empty if you don&apos;t have it.
          </span>
        ) : null}
      </div>
    </Dialog>
  );
}
