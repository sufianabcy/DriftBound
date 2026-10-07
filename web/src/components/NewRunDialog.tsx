import { useState } from 'react'
import type { FormEvent, RefObject } from 'react'
import { DEFAULT_RUN } from '../lib/api'
import type { NewRun } from '../lib/api'
import type { Mode } from '../lib/types'

export function NewRunDialog({
  dialogRef,
  onCreate,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>
  onCreate: (run: NewRun) => void
}) {
  const [form, setForm] = useState({ name: '', mode: 'exact' as Mode, n: '1023', p: '1', noise: '0', seed: '', memory: true })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    onCreate({
      ...DEFAULT_RUN,
      name: form.name.trim() || undefined,
      mode: form.mode,
      n: Number(form.n),
      p: Number(form.p),
      noise: Number(form.noise),
      seed: form.seed === '' ? undefined : Number(form.seed),
      memory: form.memory,
    })
    dialogRef.current?.close()
  }

  return (
    <dialog ref={dialogRef} aria-labelledby="new-run-title">
      <form onSubmit={submit}>
        <h2 id="new-run-title">New run</h2>
        <div className="dialog-grid">
          <label style={{ gridColumn: '1 / -1' }}>
            Name (optional)
            <input type="text" maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label>
            Mode
            <select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as Mode })}>
              <option value="exact">Exact</option>
              <option value="robust">Robust</option>
            </select>
          </label>
          <label>
            Inputs N
            <input type="number" min={1} max={100000} required value={form.n} onChange={(e) => setForm({ ...form, n: e.target.value })} />
          </label>
          <label>
            Monitoring rate p
            <input type="number" min={0} max={1} step={0.05} required value={form.p} onChange={(e) => setForm({ ...form, p: e.target.value })} />
          </label>
          <label>
            Label noise
            <input
              type="number"
              min={0}
              max={0.49}
              step={0.01}
              required
              value={form.noise}
              onChange={(e) => setForm({ ...form, noise: e.target.value })}
            />
          </label>
          <label>
            Seed (optional)
            <input type="number" value={form.seed} onChange={(e) => setForm({ ...form, seed: e.target.value })} />
          </label>
          <label className="switch" style={{ alignSelf: 'end', minHeight: 38 }}>
            <span>Concept memory</span>
            <input type="checkbox" checked={form.memory} onChange={(e) => setForm({ ...form, memory: e.target.checked })} />
          </label>
        </div>
        <p className="hint" style={{ marginTop: 10 }}>
          N = 1023 gives 1,024 threshold rules, so the proven recovery bound is ⌈log₂ 1024⌉ = 10 labels.
        </p>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={() => dialogRef.current?.close()}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            Create and start
          </button>
        </div>
      </form>
    </dialog>
  )
}
