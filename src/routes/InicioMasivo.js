// src/routes/InicioMasivo.js (VERSIÓN COMPLETA CON FILTROS)
import express from 'express';
import pool from '../config/db.js';
import multer from 'multer';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';


const ESTADO_ANULADA = 4; // id_esta=4 en doa2.estado_oc

const router = express.Router();
const upload = multer({ 
    dest: 'uploads/',
    limits: {
        fileSize: 50 * 1024 * 1024 // 50MB límite
    }
});

// 🎯 ENDPOINTS DE FILTROS
router.get('/filtros/centros-costo', async (req, res) => {
    try {
        const query = `
            SELECT id_ceco, codigo, descripcion
            FROM doa2.centro_costo 
            WHERE estado_registro = 'A'
            ORDER BY descripcion
        `;

        const result = await pool.query(query);
        
        res.json({
            success: true,
            data: result.rows
        });

    } catch (error) {
        console.error('Error obteniendo centros de costo:', error);
        res.status(500).json({
            success: false,
            message: 'Error obteniendo centros de costo'
        });
    }
});

router.get('/filtros/companias', async (req, res) => {
    try {
        const query = `
            SELECT id_compania, codigo_compania, nombre_compania
            FROM doa2.companias 
            WHERE estado_registro = 'A'
            ORDER BY nombre_compania
        `;

        const result = await pool.query(query);
        
        res.json({
            success: true,
            data: result.rows
        });

    } catch (error) {
        console.error('Error obteniendo compañías:', error);
        res.status(500).json({
            success: false,
            message: 'Error obteniendo compañías'
        });
    }
});

router.get('/filtros/estados-oc', async (req, res) => {
    try {
        const query = `
            SELECT id_esta, descripcion
            FROM doa2.estado_oc 
            WHERE estado_registro = 'A'
            ORDER BY descripcion
        `;

        const result = await pool.query(query);
        
        res.json({
            success: true,
            data: result.rows
        });

    } catch (error) {
        console.error('Error obteniendo estados OC:', error);
        res.status(500).json({
            success: false,
            message: 'Error obteniendo estados OC'
        });
    }
});

router.get('/filtros/proveedores', async (req, res) => {
    try {
        const query = `
            SELECT DISTINCT nit_proveedor, nombre_proveedor
            FROM doa2.cabecera_oc_pendientes 
            WHERE estado_registro = 'A'
            AND nit_proveedor IS NOT NULL
            ORDER BY nombre_proveedor
        `;

        const result = await pool.query(query);
        
        res.json({
            success: true,
            data: result.rows
        });

    } catch (error) {
        console.error('Error obteniendo proveedores:', error);
        res.status(500).json({
            success: false,
            message: 'Error obteniendo proveedores'
        });
    }
});

router.get('/filtros/sistemas', async (req, res) => {
    try {
        const query = `
            SELECT DISTINCT sistema
            FROM doa2.cabecera_oc_pendientes 
            WHERE estado_registro = 'A'
            AND sistema IS NOT NULL
            ORDER BY sistema
        `;

        const result = await pool.query(query);
        
        res.json({
            success: true,
            data: result.rows
        });

    } catch (error) {
        console.error('Error obteniendo sistemas:', error);
        res.status(500).json({
            success: false,
            message: 'Error obteniendo sistemas'
        });
    }
});

// 📊 CONSULTAR ÓRDENES PENDIENTES CON FILTROS COMPLETOS
router.get('/ordenes-pendientes', async (req, res) => {
    try {
        const { 
            pagina = 1, 
            porPagina = 50, 
            numeroOrden, 
            numeroSolicitud, 
            proveedor,
            centroCosto,
            compania,
            sistema,
            estadoArchivos,
            prioridad,
            requierePoliza,
            requiereContrato,
            fechaInicio,
            fechaFin
        } = req.query;

        const offset = (pagina - 1) * porPagina;
        let whereConditions = [
            "cop.estado_registro = 'A'",
            "(cop.orden_gestionada IS NULL OR cop.orden_gestionada = 'N')"
        ];
        let params = [];
        let paramCount = 0;

        // 🔍 APLICAR FILTROS DINÁMICOS
        if (numeroOrden) {
            paramCount++;
            whereConditions.push(`cop.numero_orden_compra ILIKE $${paramCount}`);
            params.push(`%${numeroOrden}%`);
        }

        if (numeroSolicitud) {
            paramCount++;
            whereConditions.push(`cop.numero_solicitud ILIKE $${paramCount}`);
            params.push(`%${numeroSolicitud}%`);
        }

        if (proveedor) {
            paramCount++;
            whereConditions.push(`cop.nit_proveedor = $${paramCount}`);
            params.push(proveedor);
        }

        if (centroCosto) {
            paramCount++;
            whereConditions.push(`cop.centrocosto = $${paramCount}`);
            params.push(centroCosto);
        }

        if (compania) {
            paramCount++;
            whereConditions.push(`cop.compania = $${paramCount}`);
            params.push(compania);
        }

        if (sistema) {
            paramCount++;
            whereConditions.push(`cop.sistema = $${paramCount}`);
            params.push(sistema);
        }

        if (estadoArchivos) {
            paramCount++;
            whereConditions.push(`cop.archivo_almacenado = $${paramCount}`);
            params.push(estadoArchivos);
        }

        if (prioridad) {
            paramCount++;
            whereConditions.push(`cop.prioridad_orden = $${paramCount}`);
            params.push(prioridad);
        }

        if (requierePoliza) {
            paramCount++;
            whereConditions.push(`cop.requiere_poliza = $${paramCount}`);
            params.push(requierePoliza);
        }

        if (requiereContrato) {
            paramCount++;
            whereConditions.push(`cop.requiere_contrato = $${paramCount}`);
            params.push(requiereContrato);
        }

        if (fechaInicio) {
            paramCount++;
            whereConditions.push(`cop.fecha_orden_compra >= $${paramCount}`);
            params.push(fechaInicio);
        }

        if (fechaFin) {
            paramCount++;
            whereConditions.push(`cop.fecha_orden_compra <= $${paramCount}`);
            params.push(fechaFin);
        }

        const whereClause = whereConditions.length > 0 ? 
            `WHERE ${whereConditions.join(' AND ')}` : '';

        // 📋 QUERY PRINCIPAL CON PAGINACIÓN
        const query = `
            SELECT 
                cop.id_cabepen,
                cop.numero_solicitud,
                cop.numero_orden_compra,
                cop.fecha_orden_compra,
                cop.fecha_sugerida,
                cop.nombre_proveedor,
                cop.nit_proveedor,
                cop.moneda,
                cop.total_neto,
                cop.centrocosto,
                cop.compania,
                cop.sistema,
                cop.solicitante,
                cop.prioridad_orden,
                cop.requiere_poliza,
                cop.requiere_contrato,
                cop.orden_gestionada,
                cop.archivo_almacenado,
                cop.envio_correo,
                cop.anular,
                cop.inicio_masivo,
                eo.descripcion as estado_descripcion,
                
                -- Contar archivos adjuntos
                (SELECT COUNT(*) FROM doa2.archivos_adjuntos aa 
                 WHERE aa.cabecera_oc_pendientes_id_cabe = cop.id_cabepen 
                 AND aa.estado_registro = 'A') as total_adjuntos,
                
                -- Detalles de items
                (SELECT JSON_AGG(
                    JSON_BUILD_OBJECT(
                        'referencia', dop.referencia,
                        'descripcion', dop.descripcion_referencia,
                        'cantidad', dop.cantidad,
                        'valor_unitario', dop.valor_unidad,
                        'valor_total', dop.valor_total
                    )
                ) 
                FROM doa2.detalle_oc_pendiente dop 
                WHERE dop.id_cabepen = cop.id_cabepen
                AND dop.estado_registro = 'A') as items,
                
                -- Polizas si requiere
                (SELECT JSON_AGG(
                    JSON_BUILD_Object(
                        'tipo_poliza', tp.descripcion,
                        'porcentaje', tpox.porcentaje
                    )
                ) 
                FROM doa2.tipo_poliza_x_oc tpox
                JOIN doa2.tipo_poliza tp ON tpox.tipo_poliza_id_tipo = tp.id_tipo
                WHERE tpox.cabecera_oc_pendientes_id_cabe = cop.id_cabepen
                AND tpox.estado_registro = 'A') as polizas
                
            FROM doa2.cabecera_oc_pendientes cop
            LEFT JOIN doa2.estado_oc eo ON cop.estado_oc_id_esta = eo.id_esta
            ${whereClause}
            ORDER BY cop.fecha_orden_compra DESC
            LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
        `;

        params.push(porPagina, offset);
        const result = await pool.query(query, params);

        // 📊 TOTAL DE REGISTROS PARA PAGINACIÓN
        const countQuery = `
            SELECT COUNT(*) as total 
            FROM doa2.cabecera_oc_pendientes cop
            ${whereClause}
        `;
        
        const countResult = await pool.query(countQuery, params.slice(0, -2));
        const total = parseInt(countResult.rows[0].total);

        res.json({
            success: true,
            data: result.rows,
            paginacion: {
                pagina: parseInt(pagina),
                porPagina: parseInt(porPagina),
                total,
                totalPaginas: Math.ceil(total / porPagina)
            },
            filtros: {
                numeroOrden,
                numeroSolicitud,
                proveedor,
                centroCosto,
                compania,
                sistema,
                estadoArchivos,
                prioridad,
                requierePoliza,
                requiereContrato,
                fechaInicio,
                fechaFin
            }
        });

    } catch (error) {
        console.error('Error consultando órdenes pendientes:', error);
        res.status(500).json({
            success: false,
            message: 'Error interno del servidor'
        });
    }
});

// 📊 ESTADÍSTICAS DE ÓRDENES PENDIENTES
router.get('/estadisticas', async (req, res) => {
    try {
        const queries = {
            total: `
                SELECT COUNT(*) as total
                FROM doa2.cabecera_oc_pendientes 
                WHERE estado_registro = 'A'
                AND (orden_gestionada IS NULL OR orden_gestionada = 'N')
            `,
            conArchivos: `
                SELECT COUNT(*) as total
                FROM doa2.cabecera_oc_pendientes 
                WHERE estado_registro = 'A'
                AND (orden_gestionada IS NULL OR orden_gestionada = 'N')
                AND archivo_almacenado = 'S'
            `,
            sinArchivos: `
                SELECT COUNT(*) as total
                FROM doa2.cabecera_oc_pendientes 
                WHERE estado_registro = 'A'
                AND (orden_gestionada IS NULL OR orden_gestionada = 'N')
                AND (archivo_almacenado IS NULL OR archivo_almacenado = 'N')
            `,
            porCompania: `
                SELECT compania, COUNT(*) as total
                FROM doa2.cabecera_oc_pendientes 
                WHERE estado_registro = 'A'
                AND (orden_gestionada IS NULL OR orden_gestionada = 'N')
                AND compania IS NOT NULL
                GROUP BY compania
                ORDER BY total DESC
            `,
            porPrioridad: `
                SELECT prioridad_orden, COUNT(*) as total
                FROM doa2.cabecera_oc_pendientes 
                WHERE estado_registro = 'A'
                AND (orden_gestionada IS NULL OR orden_gestionada = 'N')
                AND prioridad_orden IS NOT NULL
                GROUP BY prioridad_orden
                ORDER BY total DESC
            `
        };

        const resultados = await Promise.all(
            Object.values(queries).map(query => pool.query(query))
        );

        res.json({
            success: true,
            data: {
                total: parseInt(resultados[0].rows[0].total),
                conArchivos: parseInt(resultados[1].rows[0].total),
                sinArchivos: parseInt(resultados[2].rows[0].total),
                porCompania: resultados[3].rows,
                porPrioridad: resultados[4].rows
            }
        });

    } catch (error) {
        console.error('Error obteniendo estadísticas:', error);
        res.status(500).json({
            success: false,
            message: 'Error obteniendo estadísticas'
        });
    }
});

// 📎 OBTENER ARCHIVOS ADJUNTOS DE UNA ORDEN
router.get('/orden/:id/adjuntos', async (req, res) => {
    try {
        const { id } = req.params;

        const query = `
            SELECT 
                id_arad,
                nombre_archivo,
                extension,
                fecha_creacion,
                oper_creador,
                archivo,
                ubicacion
            FROM doa2.archivos_adjuntos 
            WHERE cabecera_oc_pendientes_id_cabe = $1 
            AND estado_registro = 'A'
            ORDER BY fecha_creacion DESC
        `;

        const result = await pool.query(query, [id]);

        res.json({
            success: true,
            data: result.rows
        });

    } catch (error) {
        console.error('Error obteniendo adjuntos:', error);
        res.status(500).json({
            success: false,
            message: 'Error obteniendo archivos adjuntos'
        });
    }
});

// 📤 DESCARGAR ARCHIVO ADJUNTO
router.get('/adjunto/:id/download', async (req, res) => {
    try {
        const { id } = req.params;

        const query = `
            SELECT nombre_archivo, extension, archivo 
            FROM doa2.archivos_adjuntos 
            WHERE id_arad = $1 
            AND estado_registro = 'A'
        `;

        const result = await pool.query(query, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Archivo no encontrado'
            });
        }

        const archivo = result.rows[0];
        const buffer = archivo.archivo;

        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', 
            `attachment; filename="${archivo.nombre_archivo}.${archivo.extension}"`);
        res.setHeader('Content-Length', buffer.length);

        res.send(buffer);

    } catch (error) {
        console.error('Error descargando archivo:', error);
        res.status(500).json({
            success: false,
            message: 'Error descargando archivo'
        });
    }
});

// 🖱️ MARCAR/DESMARCAR ORDEN PARA PROCESO MASIVO
router.post('/marcar-orden', async (req, res) => {
    const { ordenes, usuario, accion } = req.body;

    try {
        if (!ordenes || !Array.isArray(ordenes) || ordenes.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No se especificaron órdenes'
            });
        }

        const query = `
            UPDATE doa2.cabecera_oc_pendientes 
            SET 
                orden_gestionada = $1,
                fecha_modificacion = NOW(),
                oper_modifica = $2
            WHERE id_cabepen = ANY($3::bigint[])
            AND estado_registro = 'A'
            RETURNING id_cabepen, numero_orden_compra, orden_gestionada
        `;

        const result = await pool.query(query, [
            accion === 'marcar' ? 'S' : 'N',
            usuario,
            ordenes
        ]);

        res.json({
            success: true,
            message: `${result.rowCount} órdenes ${accion === 'marcar' ? 'marcadas' : 'desmarcadas'} exitosamente`,
            data: result.rows
        });

    } catch (error) {
        console.error('Error marcando órdenes:', error);
        res.status(500).json({
            success: false,
            message: 'Error interno del servidor'
        });
    }
});

// 📝 PROCESAR ARCHIVO EXCEL MASIVO CON EXCELJS
router.post('/procesar-excel', upload.single('archivo'), async (req, res) => {
    let workbook;
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No se envió ningún archivo'
            });
        }

        workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(req.file.path);
        
        const worksheet = workbook.getWorksheet(1);
        const resultados = [];
        const errores = [];

        worksheet.eachRow(async (row, rowNumber) => {
            if (rowNumber === 1) return;

            try {
                const rowData = {
                    numero_orden_compra: row.getCell(1).value,
                    sistema: row.getCell(2).value,
                    observaciones: row.getCell(3).value,
                    requiere_contrato: row.getCell(4).value,
                    requiere_poliza: row.getCell(5).value,
                    anular: row.getCell(6).value,
                    envio_correo: row.getCell(7).value
                };

                if (!rowData.numero_orden_compra || !rowData.sistema) {
                    throw new Error('Faltan campos obligatorios');
                }

                const ordenExistente = await pool.query(
                    `SELECT id_cabepen FROM doa2.cabecera_oc_pendientes 
                     WHERE numero_orden_compra = $1 AND sistema = $2`,
                    [rowData.numero_orden_compra, rowData.sistema]
                );

                if (ordenExistente.rows.length === 0) {
                    throw new Error('Orden no encontrada');
                }

                const updateQuery = `
                    UPDATE doa2.cabecera_oc_pendientes 
                    SET 
                        observaciones = COALESCE($1, observaciones),
                        requiere_contrato = COALESCE($2, requiere_contrato),
                        requiere_poliza = COALESCE($3, requiere_poliza),
                        anular = COALESCE($4, anular),
                        envio_correo = COALESCE($5, envio_correo),
                        fecha_modificacion = NOW(),
                        oper_modifica = $6
                    WHERE id_cabepen = $7
                    RETURNING *
                `;

                const result = await pool.query(updateQuery, [
                    rowData.observaciones,
                    rowData.requiere_contrato || 'N',
                    rowData.requiere_poliza || 'N',
                    rowData.anular || 'N',
                    rowData.envio_correo || 'S',
                    req.body.usuario,
                    ordenExistente.rows[0].id_cabepen
                ]);

                resultados.push({
                    fila: rowNumber,
                    orden: rowData.numero_orden_compra,
                    accion: 'actualizada',
                    data: result.rows[0]
                });

            } catch (error) {
                errores.push({
                    fila: rowNumber,
                    orden: row.getCell(1).value,
                    error: error.message
                });
            }
        });

        await Promise.allSettled(resultados);
        fs.unlinkSync(req.file.path);

        res.json({
            success: true,
            message: 'Procesamiento de Excel completado',
            resultados,
            errores
        });

    } catch (error) {
        console.error('Error procesando Excel:', error);
        if (req.file) fs.unlinkSync(req.file.path);
        res.status(500).json({
            success: false,
            message: 'Error procesando archivo Excel'
        });
    }
});

// 📦 PROCESAR ARCHIVO ZIP CON ADJUNTOS
router.post('/procesar-zip', upload.single('archivo'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No se envió ningún archivo'
            });
        }

        const zip = new JSZip();
        const content = await zip.loadAsync(fs.readFileSync(req.file.path));
        const resultados = [];
        const errores = [];

        for (const [filename, file] of Object.entries(content.files)) {
            if (!file.dir) {
                try {
                    const pathParts = filename.split('/');
                    const ordenFolder = pathParts[pathParts.length - 2];
                    const nombreArchivo = pathParts[pathParts.length - 1];
                    
                    if (!ordenFolder || !nombreArchivo) {
                        throw new Error('Estructura inválida');
                    }

                    const ordenExistente = await pool.query(
                        `SELECT id_cabepen FROM doa2.cabecera_oc_pendientes 
                         WHERE numero_orden_compra = $1`,
                        [ordenFolder]
                    );

                    if (ordenExistente.rows.length === 0) {
                        throw new Error(`Orden ${ordenFolder} no existe`);
                    }

                    const ordenId = ordenExistente.rows[0].id_cabepen;
                    const fileContent = await file.async('nodebuffer');
                    const extension = path.extname(nombreArchivo).toLowerCase().replace('.', '');
                    
                    const insertQuery = `
                        INSERT INTO doa2.archivos_adjuntos 
                        (nombre_archivo, archivo, extension, cabecera_oc_pendientes_id_cabe, 
                         fecha_creacion, oper_creador, estado_registro)
                        VALUES ($1, $2, $3, $4, NOW(), $5, 'A')
                        RETURNING id_arad, nombre_archivo
                    `;

                    const result = await pool.query(insertQuery, [
                        nombreArchivo,
                        fileContent,
                        extension,
                        ordenId,
                        req.body.usuario
                    ]);

                    await pool.query(
                        `UPDATE doa2.cabecera_oc_pendientes 
                         SET archivo_almacenado = 'S' 
                         WHERE id_cabepen = $1`,
                        [ordenId]
                    );

                    resultados.push({
                        archivo: nombreArchivo,
                        orden: ordenFolder,
                        id_adjunto: result.rows[0].id_arad
                    });

                } catch (error) {
                    errores.push({
                        archivo: filename,
                        error: error.message
                    });
                }
            }
        }

        fs.unlinkSync(req.file.path);

        res.json({
            success: true,
            message: 'Procesamiento ZIP completado',
            resultados,
            errores
        });

    } catch (error) {
        console.error('Error procesando ZIP:', error);
        if (req.file) fs.unlinkSync(req.file.path);
        res.status(500).json({
            success: false,
            message: 'Error procesando archivo ZIP'
        });
    }
});

// 🚀 INICIAR PROCESO MASIVO DE ÓRDENES
router.post('/iniciar-proceso-masivo', async (req, res) => {
  const { usuario, ignorarAdjuntos } = req.body;

  try {
    const ordenesSeleccionadas = await pool.query(`
      SELECT id_cabepen, numero_orden_compra, archivo_almacenado, estado_oc_id_esta
      FROM doa2.cabecera_oc_pendientes 
      WHERE orden_gestionada = 'S' 
        AND estado_registro = 'A'
        AND COALESCE(estado_oc_id_esta, 0) <> $1  -- 👈 excluye ANULADA
    `, [ESTADO_ANULADA]);

    if (ordenesSeleccionadas.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'No hay órdenes seleccionadas' });
    }

    const sinAdjuntos = ordenesSeleccionadas.rows
      .filter(o => o.archivo_almacenado !== 'S')
      .map(o => o.numero_orden_compra);

    if (!ignorarAdjuntos && sinAdjuntos.length > 0) {
      return res.json({
        success: false,
        requiereConfirmacion: true,
        message: 'Algunas órdenes no tienen archivos adjuntos',
        ordenesSinArchivos: sinAdjuntos
      });
    }

    const resultadoProceso = await iniciarProcesoOrdenes(ordenesSeleccionadas.rows, usuario);
    res.json({ success: true, message: 'Proceso masivo iniciado exitosamente', data: resultadoProceso });
  } catch (error) {
    console.error('Error iniciando proceso masivo:', error);
    res.status(500).json({ success: false, message: 'Error iniciando proceso masivo' });
  }
});
// 🗑️ ELIMINAR ORDEN
router.delete('/orden/:id', async (req, res) => {
    const { id } = req.params;
    const { usuario } = req.body;

    try {
        const orden = await pool.query(`
            SELECT orden_gestionada FROM doa2.cabecera_oc_pendientes 
            WHERE id_cabepen = $1 AND estado_registro = 'A'
        `, [id]);

        if (orden.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Orden no encontrada'
            });
        }

        if (orden.rows[0].orden_gestionada === 'S') {
            return res.status(400).json({
                success: false,
                message: 'No se puede eliminar orden gestionada'
            });
        }

        const result = await pool.query(`
            UPDATE doa2.cabecera_oc_pendientes 
            SET estado_registro = 'I', fecha_modificacion = NOW(), oper_modifica = $1
            WHERE id_cabepen = $2
            RETURNING numero_orden_compra
        `, [usuario, id]);

        res.json({
            success: true,
            message: 'Orden eliminada exitosamente',
            data: result.rows[0]
        });

    } catch (error) {
        console.error('Error eliminando orden:', error);
        res.status(500).json({
            success: false,
            message: 'Error eliminando orden'
        });
    }
});

// Función auxiliar para iniciar proceso de órdenes
async function iniciarProcesoOrdenes(ordenes, usuario) {
    const resultados = [];
    
    for (const orden of ordenes) {
        try {
            await pool.query(`
                UPDATE doa2.cabecera_oc_pendientes 
                SET estado_oc_id_esta = 2, fecha_modificacion = NOW(), oper_modifica = $1
                WHERE id_cabepen = $2
            `, [usuario, orden.id_cabepen]);

            resultados.push({
                orden: orden.numero_orden_compra,
                estado: 'procesada',
                exito: true
            });
        } catch (error) {
            resultados.push({
                orden: orden.numero_orden_compra,
                estado: 'error',
                exito: false,
                error: error.message
            });
        }
    }

    return resultados;
}

router.post('/orden/:id/anular', async (req, res) => {
  const { id } = req.params;
  const { usuario, motivo } = req.body || {};

  if (!usuario || !motivo) {
    return res.status(400).json({ success: false, message: 'usuario y motivo son obligatorios' });
  }

  try {
    const qSel = `
      SELECT id_cabepen, numero_orden_compra, orden_gestionada, estado_registro, estado_oc_id_esta
      FROM doa2.cabecera_oc_pendientes
      WHERE id_cabepen = $1
    `;
    const rSel = await pool.query(qSel, [id]);
    if (rSel.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Orden no encontrada' });
    }
    const row = rSel.rows[0];

    if (row.estado_registro !== 'A') {
      return res.status(400).json({ success: false, message: 'La orden no está activa' });
    }
    if (row.estado_oc_id_esta === ESTADO_ANULADA) {
      return res.status(409).json({ success: false, message: 'La orden ya está ANULADA' });
    }
    if (row.orden_gestionada === 'S') {
      return res.status(400).json({ success: false, message: 'No se puede anular una orden ya gestionada' });
    }

    await pool.query(`
      UPDATE doa2.cabecera_oc_pendientes
      SET anular = 'S',
          estado_oc_id_esta = $2,              -- 👈 ANULADA (id_esta=4)
          orden_gestionada = 'N',              -- por si acaso estaba marcada
          fecha_modificacion = NOW(),
          oper_modifica = $3,
          observaciones = CONCAT(COALESCE(observaciones,''), E'\n[ANULADA] ', NOW()::text, ' · ', $3, ' · ', $4)
      WHERE id_cabepen = $1
    `, [id, ESTADO_ANULADA, usuario, motivo]);

    await pool.query(`
      INSERT INTO doa2.auditoria_oc (id_cabepen, accion, usuario, detalle, fecha)
      VALUES ($1, 'ANULAR', $2, $3, NOW())
    `, [id, usuario, `Motivo: ${motivo}`]);

    res.json({ success: true, message: `OC ${row.numero_orden_compra} anulada.` });
  } catch (error) {
    console.error('Error anulando orden:', error);
    res.status(500).json({ success: false, message: 'Error anulando orden' });
  }
});

router.post('/anular-masivo', async (req, res) => {
  const { ordenes, usuario, motivo } = req.body || {};
  if (!Array.isArray(ordenes) || !ordenes.length) {
    return res.status(400).json({ success: false, message: 'Sin órdenes' });
  }
  if (!usuario || !motivo) {
    return res.status(400).json({ success: false, message: 'usuario y motivo son obligatorios' });
  }

  try {
    const qSel = `
      SELECT id_cabepen, numero_orden_compra
      FROM doa2.cabecera_oc_pendientes
      WHERE id_cabepen = ANY($1::bigint[])
        AND estado_registro = 'A'
        AND (orden_gestionada IS NULL OR orden_gestionada = 'N')
        AND (estado_oc_id_esta IS DISTINCT FROM $2)
    `;
    const rSel = await pool.query(qSel, [ordenes, ESTADO_ANULADA]);
    const idsValidos = rSel.rows.map(r => r.id_cabepen);

    if (!idsValidos.length) {
      return res.status(400).json({ success: false, message: 'No hay órdenes elegibles para anular' });
    }

    await pool.query(`
      UPDATE doa2.cabecera_oc_pendientes
      SET anular = 'S',
          estado_oc_id_esta = $2,             -- 👈 ANULADA (id_esta=4)
          orden_gestionada = 'N',
          fecha_modificacion = NOW(),
          oper_modifica = $3,
          observaciones = CONCAT(COALESCE(observaciones,''), E'\n[ANULADA] ', NOW()::text, ' · ', $3, ' · ', $4)
      WHERE id_cabepen = ANY($1::bigint[])
    `, [idsValidos, ESTADO_ANULADA, usuario, motivo]);

    res.json({
      success: true,
      message: `Se anularon ${idsValidos.length} órdenes.`,
      anuladas: rSel.rows.map(r => r.numero_orden_compra),
      omitidas: ordenes.filter(id => !idsValidos.includes(id))
    });
  } catch (error) {
    console.error('Error anular-masivo:', error);
    res.status(500).json({ success: false, message: 'Error en anulación masiva' });
  }
});

export default router;