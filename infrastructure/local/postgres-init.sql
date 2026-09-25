-- Se ejecuta solo la primera vez que arranca el contenedor local.
-- Crea la base separada para los tests automáticos (se borra y recrea en cada test).
CREATE DATABASE clipflow_test OWNER clipflow;
