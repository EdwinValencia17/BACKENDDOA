import pool from "../../config/db.js";
import express from "express";

const router = express.Router();

// GET - Obtener todos los estados de OC
export const getAllEstadosOc = async (req, res) => {
  try {
    const query = `
      SELECT id_esta, descripcion, fecha_creacion, oper_creador, 
             fecha_modificacion, oper_modifica, estado_registro
      FROM doa2.estado_oc
      WHERE estado_registro = 'A'
      ORDER BY id_esta
    `;
    
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// GET - Obtener estado de OC por ID
export const getEstadoOcById = async (req, res) => {
  try {
    const { id } = req.params;
    const query = `
      SELECT id_esta, descripcion, fecha_creacion, oper_creador, 
             fecha_modificacion, oper_modifica, estado_registro
      FROM doa2.estado_oc
      WHERE id_esta = $1 AND estado_registro = 'A'
    `;
    
    const result = await pool.query(query, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Estado de OC no encontrado' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// POST - Crear nuevo estado de OC
export const createEstadoOc = async (req, res) => {
  try {
    const { descripcion, oper_creador } = req.body;
    
    const query = `
      INSERT INTO doa2.estado_oc 
        (descripcion, oper_creador, fecha_creacion, estado_registro)
      VALUES ($1, $2, NOW(), 'A')
      RETURNING id_esta, descripcion, fecha_creacion, oper_creador, 
                fecha_modificacion, oper_modifica, estado_registro
    `;
    
    const result = await pool.query(query, [descripcion, oper_creador]);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// PUT - Actualizar estado de OC
export const updateEstadoOc = async (req, res) => {
  try {
    const { id } = req.params;
    const { descripcion, oper_modifica } = req.body;
    
    const query = `
      UPDATE doa2.estado_oc 
      SET descripcion = $1, 
          oper_modifica = $2, 
          fecha_modificacion = NOW()
      WHERE id_esta = $3 AND estado_registro = 'A'
      RETURNING id_esta, descripcion, fecha_creacion, oper_creador, 
                fecha_modificacion, oper_modifica, estado_registro
    `;
    
    const result = await pool.query(query, [descripcion, oper_modifica, id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Estado de OC no encontrado' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// DELETE - Eliminar estado de OC (soft delete)
export const deleteEstadoOc = async (req, res) => {
  try {
    const { id } = req.params;
    const { oper_modifica } = req.body;
    
    const query = `
      UPDATE doa2.estado_oc 
      SET estado_registro = 'I', 
          oper_modifica = $1, 
          fecha_modificacion = NOW()
      WHERE id_esta = $2
      RETURNING id_esta, estado_registro
    `;
    
    const result = await pool.query(query, [oper_modifica, id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Estado de OC no encontrado' });
    }
    
    res.json({ message: 'Estado de OC eliminado correctamente' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// GET - Buscar estados de OC por descripción
export const searchEstadosOc = async (req, res) => {
  try {
    const { search } = req.query;
    
    const query = `
      SELECT id_esta, descripcion, fecha_creacion, oper_creador, 
             fecha_modificacion, oper_modifica, estado_registro
      FROM doa2.estado_oc
      WHERE estado_registro = 'A'
        AND (descripcion ILIKE $1 OR id_esta::text ILIKE $1)
      ORDER BY id_esta
    `;
    
    const result = await pool.query(query, [`%${search}%`]);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Rutas
router.get('/', getAllEstadosOc);
router.get('/search', searchEstadosOc);
router.get('/:id', getEstadoOcById);
router.post('/', createEstadoOc);
router.put('/:id', updateEstadoOc);
router.delete('/:id', deleteEstadoOc);

export default router;