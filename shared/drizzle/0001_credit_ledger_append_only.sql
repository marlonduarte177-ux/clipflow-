-- El libro de créditos solo admite INSERT: nadie (ni la propia API) puede
-- modificar o borrar movimientos. Las correcciones se hacen con un nuevo
-- movimiento de tipo 'adjustment' o 'refund'.
CREATE FUNCTION credit_ledger_block_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'credit_ledger es de solo inserción: registra un ajuste en lugar de modificar'
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER credit_ledger_no_update_delete
  BEFORE UPDATE OR DELETE ON credit_ledger
  FOR EACH ROW EXECUTE FUNCTION credit_ledger_block_changes();
--> statement-breakpoint
CREATE TRIGGER credit_ledger_no_truncate
  BEFORE TRUNCATE ON credit_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION credit_ledger_block_changes();
