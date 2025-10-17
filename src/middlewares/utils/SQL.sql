
--para borrar una OC y reabrir la pendiente
BEGIN;


DO $$
DECLARE
  v_po    text   := 'PO62769';
  v_user  text   := 'reset_test';
  v_cabep bigint;
  v_cabe  bigint;
BEGIN
  -- ids
  SELECT id_cabepen
    INTO v_cabep
    FROM doa2.cabecera_oc_pendientes
   WHERE TRIM(numero_orden_compra)=TRIM(v_po)
   ORDER BY fecha_modificacion DESC NULLS LAST, fecha_creacion DESC
   LIMIT 1;

  SELECT id_cabe
    INTO v_cabe
    FROM doa2.cabecera_oc
   WHERE TRIM(numero_orden_compra)=TRIM(v_po)
   ORDER BY fecha_creacion DESC
   LIMIT 1;

  IF v_cabe IS NOT NULL THEN
    -- borrar flujo (personas -> pasos)
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='doa2' AND table_name='lista_autorizaccion') THEN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='doa2' AND table_name='lista_autorizaccion_persona') THEN
        DELETE FROM doa2.lista_autorizaccion_persona lap
         USING doa2.lista_autorizaccion la
         WHERE lap.id_liau = la.id_liau
           AND la.cabecera_oc_id_cabe = v_cabe;
      END IF;
      DELETE FROM doa2.lista_autorizaccion
       WHERE cabecera_oc_id_cabe = v_cabe;
    END IF;

    -- borrar detalles
    DELETE FROM doa2.detalle_oc WHERE cabecera_oc_id_cabe = v_cabe;

    -- si existe vínculo de póliza, limpiarlo
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='doa2' AND table_name='tipo_poliza_x_oc' AND column_name='cabecera_oc_id_cabe'
    ) THEN
      DELETE FROM doa2.tipo_poliza_x_oc WHERE cabecera_oc_id_cabe = v_cabe;
    END IF;

    -- borrar cabecera
    DELETE FROM doa2.cabecera_oc WHERE id_cabe = v_cabe;
  END IF;

  -- reabrir pendiente
  IF v_cabep IS NOT NULL THEN
    UPDATE doa2.cabecera_oc_pendientes
       SET orden_gestionada   = 'N',
           estado_registro    = 'A',
           estado_oc_id_esta  = 0,
           oper_modifica      = v_user,
           fecha_modificacion = NOW()
     WHERE id_cabepen = v_cabep;
  END IF;
END $$;

COMMIT;


	SELECT a.id_auto, n.nivel, a.centro_costo_id_ceco, p.nombre
FROM doa2.autorizador a
JOIN doa2.nivel n   ON n.id_nive=a.nivel_id_nive
JOIN doa2.persona p ON p.id_pers=a.persona_id_pers
WHERE a.estado_registro='A'
  AND (a.centro_costo_id_ceco = (SELECT id_ceco FROM doa2.centro_costo WHERE codigo='HQ06')
       OR a.centro_costo_id_ceco IS NULL)
  AND UPPER(TRIM(n.nivel)) IN ('GERENTE OPS','45','40','30','DUENO CC')
ORDER BY n.nivel, p.nombre;


SELECT usuarioid, usrlogin, estado
FROM seguridadjci.usuario
WHERE UPPER(TRIM(usrlogin)) = UPPER(TRIM('bbernaf'));

SELECT
  LENGTH(usrpwd)           AS len,
  LEFT(TRIM(usrpwd), 4)    AS prefix,
  TRIM(usrpwd) ~ '^\$2[abxy]\$' AS is_bcrypt_like
FROM seguridadjci.usuario
WHERE UPPER(TRIM(usrlogin)) = UPPER(TRIM('bbernaf'));


SELECT
  LENGTH(usrpwd) AS len,
  LEFT(TRIM(usrpwd), 4) AS prefix
FROM seguridadjci.usuario
WHERE UPPER(TRIM(usrlogin)) = UPPER(TRIM('bbernaf'));