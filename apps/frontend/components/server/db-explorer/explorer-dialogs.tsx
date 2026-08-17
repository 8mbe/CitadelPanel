"use client";

/**
 * Dialogs for the database explorer: create table, add/edit column, insert/
 * edit row, and a destructive-confirm wrapper.
 *
 * Every form here submits *structured* specs (`DbColumnSpec`, value maps) —
 * never SQL. The type dropdown mirrors the server's fixed allowlist; anything
 * else the browser sends is rejected server-side.
 */

import * as React from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
  ApiError,
  addDatabaseColumn,
  createDatabaseTable,
  insertDatabaseRow,
  updateDatabaseColumn,
  updateDatabaseRow,
  type DbColumnSchema,
  type DbColumnSpec,
  type DbTableSchema,
} from "@/lib/api";

/** The column types the server accepts — mirrors dbExplorerSql's allowlist. */
export const COLUMN_TYPE_OPTIONS = [
  "TINYINT",
  "SMALLINT",
  "INT",
  "BIGINT",
  "DECIMAL",
  "FLOAT",
  "DOUBLE",
  "CHAR",
  "VARCHAR",
  "TEXT",
  "MEDIUMTEXT",
  "LONGTEXT",
  "BLOB",
  "DATE",
  "DATETIME",
  "TIMESTAMP",
  "TIME",
  "YEAR",
  "JSON",
  "BOOLEAN",
] as const;

const NUMERIC_TYPES = new Set([
  "TINYINT",
  "SMALLINT",
  "INT",
  "BIGINT",
  "DECIMAL",
  "FLOAT",
  "DOUBLE",
  "YEAR",
]);

const PARAMETERIZED_TYPES = new Set(["CHAR", "VARCHAR", "DECIMAL", "FLOAT", "DOUBLE"]);

/** Types whose values get a textarea rather than a one-line input. */
const LONG_TYPES = new Set(["TEXT", "MEDIUMTEXT", "LONGTEXT", "BLOB", "JSON"]);

type DefaultKind = DbColumnSpec["defaultKind"];

const DEFAULT_OPTIONS: { value: DefaultKind; label: string }[] = [
  { value: "none", label: "No default" },
  { value: "null", label: "NULL" },
  { value: "literal", label: "Value…" },
  { value: "currentTimestamp", label: "CURRENT_TIMESTAMP" },
];

/** Extract a message from a failed API call for inline form errors. */
export function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.message) return error.message;
  return fallback;
}

/**
 * Parse a column's full type text (e.g. "int unsigned", "varchar(255)") into
 * the base/length/unsigned triple the form works with. Returns null when the
 * type is not representable in the dropdown (enum, set, …) — the caller then
 * blocks editing rather than silently changing the type.
 */
export function parseColumnType(
  type: string,
): { baseType: string; length?: string; unsigned: boolean } | null {
  const match = /^([a-z0-9]+)(?:\((\d+(?:,\d+)?)\))?( unsigned)?$/i.exec(type.trim());
  if (!match) return null;
  const baseType = match[1]!.toUpperCase();
  if (!(COLUMN_TYPE_OPTIONS as readonly string[]).includes(baseType)) return null;
  return { baseType, length: match[2], unsigned: Boolean(match[3]) };
}

/**
 * A confirm step for destructive actions. The trigger is passed as an element
 * (a Button) and gets the open-handler merged in, matching how DialogTrigger's
 * `render` prop is used across the panel.
 */
export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel,
  onConfirm,
}: {
  trigger: React.ReactElement<{ onClick?: () => void }>;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => Promise<void> | void;
}) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger} />
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => void confirm()}>
            {busy && <Spinner />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- Create table ---------------------------------------------------------------

/** A column row in the create-table form, with a stable React key. */
interface DraftColumn {
  key: string;
  spec: DbColumnSpec;
}

const blankColumn = (): DbColumnSpec => ({
  name: "",
  baseType: "VARCHAR",
  length: "255",
  nullable: false,
  defaultKind: "none",
});

/**
 * Create-table dialog: a table name plus a stack of column rows. Validation is
 * server-side (all problems at once); the dialog only enforces "give it a
 * name" locally so obviously-empty submits don't round-trip.
 */
export function CreateTableDialog({
  serverId,
  databaseId,
  onCreated,
}: {
  serverId: string;
  databaseId: string;
  onCreated: (table: string) => void | Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [table, setTable] = React.useState("");
  const [columns, setColumns] = React.useState<DraftColumn[]>([]);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const keySeed = React.useRef(0);

  const addColumn = () => {
    keySeed.current += 1;
    setColumns((prev) => [...prev, { key: `col-${keySeed.current}`, spec: blankColumn() }]);
  };

  // Opening the dialog starts from one blank id column — the common shape.
  const openDialog = (next: boolean) => {
    setOpen(next);
    if (next) {
      setTable("");
      setError(null);
      keySeed.current += 1;
      setColumns([
        {
          key: `col-${keySeed.current}`,
          spec: {
            name: "id",
            baseType: "INT",
            unsigned: true,
            nullable: false,
            autoIncrement: true,
            primaryKey: true,
            defaultKind: "none",
          },
        },
      ]);
    }
  };

  const updateColumn = (key: string, patch: Partial<DbColumnSpec>) => {
    setColumns((prev) =>
      prev.map((c) => (c.key === key ? { ...c, spec: { ...c.spec, ...patch } } : c)),
    );
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!table.trim() || columns.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      await createDatabaseTable(serverId, databaseId, table.trim(), columns.map((c) => c.spec));
      setOpen(false);
      await onCreated(table.trim());
    } catch (err) {
      setError(apiErrorMessage(err, "Failed to create the table."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={openDialog}>
      <DialogTrigger render={<Button size="sm" />}>
        <Plus />
        New table
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create table</DialogTitle>
          <DialogDescription>
            Tables are created InnoDB with utf8mb4, matching what game servers
            create themselves.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="new-table-name">Table name</FieldLabel>
            <Input
              id="new-table-name"
              required
              placeholder="players"
              className="font-mono"
              value={table}
              onChange={(e) => setTable(e.target.value)}
            />
          </Field>

          <Field>
            <FieldLabel>Columns</FieldLabel>
            <div className="flex flex-col gap-3">
              {columns.map((column, index) => (
                <div
                  key={column.key}
                  className="flex flex-col gap-2 rounded-lg border p-3"
                >
                  <div className="grid grid-cols-[minmax(0,1fr)_8rem_5rem] items-center gap-2">
                    <Input
                      aria-label={`Column ${index + 1} name`}
                      required
                      placeholder={`column_${index + 1}`}
                      className="font-mono"
                      value={column.spec.name}
                      onChange={(e) => updateColumn(column.key, { name: e.target.value })}
                    />
                    <Select
                      value={column.spec.baseType}
                      onValueChange={(value) => {
                        if (!value) return;
                        const patch: Partial<DbColumnSpec> = { baseType: value };
                        if (!PARAMETERIZED_TYPES.has(value)) patch.length = undefined;
                        else if (!column.spec.length) patch.length = "255";
                        if (!NUMERIC_TYPES.has(value)) {
                          patch.unsigned = false;
                          patch.autoIncrement = false;
                        }
                        updateColumn(column.key, patch);
                      }}
                    >
                      <SelectTrigger aria-label={`Column ${index + 1} type`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {COLUMN_TYPE_OPTIONS.map((type) => (
                          <SelectItem key={type} value={type}>
                            {type}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {PARAMETERIZED_TYPES.has(column.spec.baseType) ? (
                      <Input
                        aria-label={`Column ${index + 1} length`}
                        placeholder="255"
                        inputMode="numeric"
                        className="font-mono"
                        value={column.spec.length ?? ""}
                        onChange={(e) => updateColumn(column.key, { length: e.target.value })}
                      />
                    ) : (
                      <span />
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
                    <label className="flex items-center gap-1.5">
                      <Checkbox
                        checked={column.spec.primaryKey === true}
                        onCheckedChange={(checked) =>
                          updateColumn(column.key, { primaryKey: checked === true })
                        }
                      />
                      Primary key
                    </label>
                    {NUMERIC_TYPES.has(column.spec.baseType) && (
                      <label className="flex items-center gap-1.5">
                        <Checkbox
                          checked={column.spec.autoIncrement === true}
                          onCheckedChange={(checked) =>
                            updateColumn(column.key, { autoIncrement: checked === true })
                          }
                        />
                        Auto increment
                      </label>
                    )}
                    {NUMERIC_TYPES.has(column.spec.baseType) && (
                      <label className="flex items-center gap-1.5">
                        <Checkbox
                          checked={column.spec.unsigned === true}
                          onCheckedChange={(checked) =>
                            updateColumn(column.key, { unsigned: checked === true })
                          }
                        />
                        Unsigned
                      </label>
                    )}
                    <label className="flex items-center gap-1.5">
                      <Checkbox
                        checked={column.spec.nullable}
                        onCheckedChange={(checked) =>
                          updateColumn(column.key, { nullable: checked === true })
                        }
                      />
                      Nullable
                    </label>
                    <Select
                      value={column.spec.defaultKind}
                      onValueChange={(value) => {
                        if (!value) return;
                        updateColumn(column.key, { defaultKind: value as DefaultKind });
                      }}
                    >
                      <SelectTrigger
                        aria-label={`Column ${index + 1} default`}
                        className="h-7 w-40 text-xs"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {DEFAULT_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {column.spec.defaultKind === "literal" && (
                      <Input
                        aria-label={`Column ${index + 1} default value`}
                        placeholder="default value"
                        className="h-7 w-36 font-mono text-xs"
                        value={column.spec.defaultValue ?? ""}
                        onChange={(e) =>
                          updateColumn(column.key, { defaultValue: e.target.value })
                        }
                      />
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="ml-auto text-muted-foreground hover:text-destructive"
                      aria-label={`Remove column ${index + 1}`}
                      disabled={columns.length === 1}
                      onClick={() =>
                        setColumns((prev) => prev.filter((c) => c.key !== column.key))
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" onClick={addColumn}>
                <Plus />
                Add column
              </Button>
            </div>
          </Field>

          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || columns.length === 0}>
              {submitting && <Spinner />}
              Create table
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Add / edit column ----------------------------------------------------------

/**
 * Add-or-edit column dialog.
 *
 * Editing restates the whole definition (`ALTER TABLE … CHANGE COLUMN`), so
 * the form is prefilled from the schema and an edit that cannot be represented
 * (enum/set types, which the dropdown does not offer) disables saving instead
 * of silently rewriting the column to something else.
 */
export function ColumnDialog({
  serverId,
  databaseId,
  table,
  editing,
  onSaved,
}: {
  serverId: string;
  databaseId: string;
  table: string;
  /** Present when editing an existing column; absent when adding one. */
  editing?: DbColumnSchema;
  onSaved: () => void | Promise<void>;
}) {
  const editingType = editing ? parseColumnType(editing.type) : null;
  const representable = !editing || editingType !== null;

  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [baseType, setBaseType] = React.useState("VARCHAR");
  const [length, setLength] = React.useState("");
  const [unsigned, setUnsigned] = React.useState(false);
  const [nullable, setNullable] = React.useState(false);
  const [autoIncrement, setAutoIncrement] = React.useState(false);
  const [defaultKind, setDefaultKind] = React.useState<DefaultKind>("none");
  const [defaultValue, setDefaultValue] = React.useState("");
  const [comment, setComment] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const prefillFrom = (column: DbColumnSchema | undefined, type: { baseType: string; length?: string; unsigned: boolean } | null) => {
    if (!column || !type) return;
    setName(column.name);
    setBaseType(type.baseType);
    setLength(type.length ?? "");
    setUnsigned(type.unsigned);
    setNullable(column.nullable);
    setAutoIncrement((column.extra ?? "").includes("auto_increment"));
    if (column.defaultValue === null) {
      setDefaultKind("none");
      setDefaultValue("");
    } else if (/^CURRENT_TIMESTAMP$/i.test(column.defaultValue)) {
      setDefaultKind("currentTimestamp");
      setDefaultValue("");
    } else {
      setDefaultKind("literal");
      setDefaultValue(column.defaultValue);
    }
    setComment(column.comment ?? "");
  };

  const openDialog = (next: boolean) => {
    setOpen(next);
    if (next) {
      setError(null);
      if (editing) {
        prefillFrom(editing, editingType);
      } else {
        setName("");
        setBaseType("VARCHAR");
        setLength("255");
        setUnsigned(false);
        setNullable(false);
        setAutoIncrement(false);
        setDefaultKind("none");
        setDefaultValue("");
        setComment("");
      }
    }
  };

  const numeric = NUMERIC_TYPES.has(baseType);
  const parameterized = PARAMETERIZED_TYPES.has(baseType);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    setError(null);
    const spec: DbColumnSpec = {
      name: name.trim(),
      baseType,
      length: parameterized ? length.trim() : undefined,
      unsigned: numeric ? unsigned : undefined,
      nullable,
      autoIncrement: numeric ? autoIncrement : undefined,
      defaultKind,
      defaultValue: defaultKind === "literal" ? defaultValue : undefined,
      comment: comment.trim() || undefined,
    };
    try {
      if (editing) {
        await updateDatabaseColumn(serverId, databaseId, table, editing.name, spec);
      } else {
        await addDatabaseColumn(serverId, databaseId, table, spec);
      }
      setOpen(false);
      await onSaved();
    } catch (err) {
      setError(apiErrorMessage(err, "Failed to save the column."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={openDialog}>
      <DialogTrigger render={<Button size="sm" />} disabled={!representable}>
        {editing ? "Edit column" : "Add column"}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit column “${editing.name}”` : "Add column"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Editing restates the whole column definition — anything you change here replaces what the table had."
              : "Adds a column to this table with ALTER TABLE … ADD COLUMN."}
          </DialogDescription>
        </DialogHeader>
        {!representable ? (
          <p className="text-sm text-muted-foreground">
            This column&apos;s type ({editing?.type}) cannot be edited here.
          </p>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div className="grid grid-cols-[minmax(0,1fr)_8rem_5rem] items-end gap-2">
              <Field>
                <FieldLabel htmlFor="column-name">Name</FieldLabel>
                <Input
                  id="column-name"
                  required
                  placeholder="score"
                  className="font-mono"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="column-type">Type</FieldLabel>
                <Select
                  value={baseType}
                  onValueChange={(value) => {
                    if (!value) return;
                    setBaseType(value);
                    if (!PARAMETERIZED_TYPES.has(value)) setLength("");
                    else if (!length) setLength("255");
                    if (!NUMERIC_TYPES.has(value)) {
                      setUnsigned(false);
                      setAutoIncrement(false);
                    }
                  }}
                >
                  <SelectTrigger id="column-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {COLUMN_TYPE_OPTIONS.map((type) => (
                      <SelectItem key={type} value={type}>
                        {type}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="column-length">Length</FieldLabel>
                <Input
                  id="column-length"
                  placeholder="255"
                  inputMode="numeric"
                  disabled={!parameterized}
                  className="font-mono"
                  value={length}
                  onChange={(e) => setLength(e.target.value)}
                />
              </Field>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
              <label className="flex items-center gap-1.5">
                <Checkbox checked={nullable} onCheckedChange={(c) => setNullable(c === true)} />
                Nullable
              </label>
              {numeric && (
                <label className="flex items-center gap-1.5">
                  <Checkbox checked={unsigned} onCheckedChange={(c) => setUnsigned(c === true)} />
                  Unsigned
                </label>
              )}
              {numeric && (
                <label className="flex items-center gap-1.5">
                  <Checkbox
                    checked={autoIncrement}
                    onCheckedChange={(c) => setAutoIncrement(c === true)}
                  />
                  Auto increment
                </label>
              )}
            </div>

            <div className="grid grid-cols-[10rem_minmax(0,1fr)] items-end gap-2">
              <Field>
                <FieldLabel htmlFor="column-default">Default</FieldLabel>
                <Select
                  value={defaultKind}
                  onValueChange={(value) => {
                    if (!value) return;
                    setDefaultKind(value as DefaultKind);
                  }}
                >
                  <SelectTrigger id="column-default">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DEFAULT_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="column-default-value">Default value</FieldLabel>
                <Input
                  id="column-default-value"
                  disabled={defaultKind !== "literal"}
                  placeholder={defaultKind === "literal" ? "value" : "—"}
                  className="font-mono"
                  value={defaultValue}
                  onChange={(e) => setDefaultValue(e.target.value)}
                />
              </Field>
            </div>

            <Field>
              <FieldLabel htmlFor="column-comment">Comment</FieldLabel>
              <Input
                id="column-comment"
                placeholder="Optional note"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
            </Field>

            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Spinner />}
                {editing ? "Save column" : "Add column"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

// --- Insert / edit row ----------------------------------------------------------

/** One row as the database returned it: column order + cell values. */
export interface RowSnapshot {
  columns: string[];
  values: (string | null)[];
}

/**
 * Insert-or-edit row dialog. Each field pairs an input with a NULL checkbox so
 * the two "empty" states (empty string vs NULL) stay distinguishable. On edit,
 * only fields whose value or null-ness changed are submitted — untouched
 * columns (including values that don't round-trip as text) are left alone.
 */
export function RowDialog({
  serverId,
  databaseId,
  table,
  schema,
  editing,
  compact,
  onSaved,
}: {
  serverId: string;
  databaseId: string;
  table: string;
  schema: DbTableSchema;
  /** Present when editing; its primary key identifies the row. */
  editing?: RowSnapshot;
  /** Icon-only trigger for dense contexts (row grids). */
  compact?: boolean;
  onSaved: () => void | Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [fields, setFields] = React.useState<{ value: string; isNull: boolean; auto: boolean }[]>([]);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const pkSet = new Set(schema.primaryKey);

  const openDialog = (next: boolean) => {
    setOpen(next);
    if (next) {
      setError(null);
      setFields(
        schema.columns.map((column) => {
          const index = editing ? editing.columns.indexOf(column.name) : -1;
          const original = editing && index >= 0 ? editing.values[index] : null;
          return {
            value: original ?? "",
            isNull: editing ? original === null : false,
            auto: (column.extra ?? "").includes("auto_increment") && !editing,
          };
        }),
      );
    }
  };

  const pkOfRow = (): Record<string, string | null> => {
    const pk: Record<string, string | null> = {};
    if (!editing) return pk;
    for (const column of schema.primaryKey) {
      const index = editing.columns.indexOf(column);
      pk[column] = index >= 0 ? editing.values[index] : null;
    }
    return pk;
  };

  const changed = fields.some((f, i) => {
    const column = schema.columns[i]!;
    if (!editing) return !(f.auto && f.value === "" && !f.isNull);
    const index = editing.columns.indexOf(column.name);
    const original = index >= 0 ? editing.values[index] : null;
    return (original ?? "") !== f.value || (original === null) !== f.isNull;
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (editing) {
        const values: Record<string, string | null> = {};
        fields.forEach((f, i) => {
          const column = schema.columns[i]!;
          if (pkSet.has(column.name)) return;
          const index = editing.columns.indexOf(column.name);
          const original = index >= 0 ? editing.values[index] : null;
          if ((original ?? "") === f.value && (original === null) === f.isNull) return;
          values[column.name] = f.isNull ? null : f.value;
        });
        await updateDatabaseRow(serverId, databaseId, table, pkOfRow(), values);
      } else {
        const values: Record<string, string | null> = {};
        fields.forEach((f, i) => {
          const column = schema.columns[i]!;
          // An untouched auto-increment column is omitted so the DB assigns it.
          if (f.auto && f.value === "" && !f.isNull) return;
          values[column.name] = f.isNull ? null : f.value;
        });
        await insertDatabaseRow(serverId, databaseId, table, values);
      }
      setOpen(false);
      await onSaved();
    } catch (err) {
      setError(apiErrorMessage(err, "Failed to save the row."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={openDialog}>
      <DialogTrigger
        render={
          <Button
            size="sm"
            disabled={schema.columns.length === 0}
            variant={compact ? "ghost" : "default"}
            aria-label={compact ? (editing ? "Edit row" : "Insert row") : undefined}
          />
        }
      >
        {editing && compact ? <Pencil /> : null}
        {!compact ? (editing ? "Edit row" : "New row") : null}
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit row" : "Insert row"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Only the fields you change are written back; the row is matched by its primary key."
              : "Fields left on “auto” are filled by the database."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto">
            {schema.columns.map((column, i) => {
              const f = fields[i];
              if (!f) return null;
              const isPk = editing && pkSet.has(column.name);
              const long = LONG_TYPES.has(
                parseColumnType(column.type)?.baseType ?? column.type,
              );
              return (
                <Field key={column.name}>
                  <FieldLabel htmlFor={`row-field-${column.name}`} className="font-mono">
                    {column.name}
                    <span className="ml-1.5 font-sans text-xs text-muted-foreground">
                      {column.type}
                    </span>
                  </FieldLabel>
                  {long && !f.isNull && !isPk ? (
                    <Textarea
                      id={`row-field-${column.name}`}
                      rows={3}
                      disabled={f.isNull || isPk}
                      className="font-mono text-xs"
                      value={f.value}
                      onChange={(e) =>
                        setFields((prev) =>
                          prev.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)),
                        )
                      }
                    />
                  ) : (
                    <Input
                      id={`row-field-${column.name}`}
                      disabled={f.isNull || isPk}
                      placeholder={f.auto ? "auto" : isPk ? undefined : "—"}
                      className="font-mono text-xs"
                      value={f.value}
                      onChange={(e) =>
                        setFields((prev) =>
                          prev.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)),
                        )
                      }
                    />
                  )}
                  {!isPk && (
                    <label className="mt-1 flex w-fit items-center gap-1.5 text-xs text-muted-foreground">
                      <Checkbox
                        checked={f.isNull}
                        onCheckedChange={(checked) =>
                          setFields((prev) =>
                            prev.map((x, j) =>
                              j === i ? { ...x, isNull: checked === true } : x,
                            ),
                          )
                        }
                      />
                      NULL
                    </label>
                  )}
                </Field>
              );
            })}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !changed}>
              {submitting && <Spinner />}
              {editing ? "Save row" : "Insert row"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
