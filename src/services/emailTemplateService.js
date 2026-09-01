const { getPool } = require('../config/database');

// =============================================================================
// Static default template definitions
// =============================================================================

const DEFAULT_TEMPLATES = [
  // Category: Order Request — matches web exactly (email-template-types.ts)
  {
    template_key: 'order_created',
    name: 'Order Request Created',
    category: 'Order Request',
    default_subject: 'New Order Request — {{order_code}} — {{company_name}}',
    body_content: '<p>{{creator_name}} placed an Order Request for {{company_name}}.</p><p>Please review the order details below.</p>',
    description: 'Sent to the order creator when a new order request is submitted',
    variables: ['{{creator_name}}', '{{company_name}}', '{{order_code}}', '{{order_url}}'],
  },
  {
    template_key: 'order_updated',
    name: 'Order Request Updated',
    category: 'Order Request',
    default_subject: 'Order Request Updated — {{order_code}} — {{company_name}}',
    body_content: '<p>{{updater_name}} updated an Order Request for {{company_name}}.</p><p>Please review the updated order details below.</p>',
    description: 'Sent to the updater and original creator when an order request is updated',
    variables: ['{{updater_name}}', '{{company_name}}', '{{order_code}}', '{{order_url}}'],
  },
  {
    template_key: 'order_accepted',
    name: 'Order Request Accepted',
    category: 'Order Request',
    default_subject: 'Order Request Accepted — {{order_code}}',
    body_content: '<p>Hello {{recipient_name}},</p><p>Congrats! Your order request {{order_code}} has been accepted.</p>',
    description: 'Sent to the order creator when an order request is accepted/approved',
    variables: ['{{recipient_name}}', '{{order_code}}', '{{status_label}}', '{{order_url}}'],
  },
  {
    template_key: 'order_rejected',
    name: 'Order Request Rejected',
    category: 'Order Request',
    default_subject: 'Order Request Rejected — {{order_code}}',
    body_content: '<p>Hello {{recipient_name}},</p><p>Your order request {{order_code}} has been rejected.</p>',
    description: 'Sent to the order creator when an order request is rejected',
    variables: ['{{recipient_name}}', '{{order_code}}', '{{status_label}}', '{{order_url}}'],
  },
];

// =============================================================================
// Database operations
// =============================================================================

// Fetch all email templates ordered by template_key
async function getEmailTemplates() {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT * FROM email_templates ORDER BY template_key ASC'
  );
  return rows || [];
}

// Fetch a single email template by id
async function getEmailTemplateById(id) {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT * FROM email_templates WHERE id = $1 LIMIT 1',
    [id]
  );
  if (!rows[0]) throw new Error(`Email template not found: id=${id}`);
  return rows[0];
}

// Fetch an active email template by template_key
async function getEmailTemplateByKey(templateKey) {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT * FROM email_templates WHERE template_key = $1 AND is_active = true LIMIT 1',
    [templateKey]
  );
  if (!rows[0]) throw new Error(`Email template not found for key "${templateKey}"`);
  return rows[0];
}

// Create a new email template
async function createEmailTemplate(input) {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO email_templates (template_key, name, subject, body_content, font_family, font_size, footer_text, is_active, tenant_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      input.template_key,
      input.name,
      input.subject,
      input.body_content || '',
      input.font_family || 'Arial, Helvetica, sans-serif',
      input.font_size || '14px',
      input.footer_text || 'This is an automated notification...',
      input.is_active !== undefined ? input.is_active : true,
      input.tenant_id || null,
    ]
  );
  return rows[0];
}

// Update an existing email template
async function updateEmailTemplate(id, input) {
  const pool = getPool();

  const setClauses = ['updated_at = $1'];
  const values = [new Date().toISOString()];
  let paramIdx = 2;

  if (input.template_key !== undefined) { setClauses.push(`template_key = $${paramIdx}`); values.push(input.template_key); paramIdx++; }
  if (input.name !== undefined) { setClauses.push(`name = $${paramIdx}`); values.push(input.name); paramIdx++; }
  if (input.subject !== undefined) { setClauses.push(`subject = $${paramIdx}`); values.push(input.subject); paramIdx++; }
  if (input.body_content !== undefined) { setClauses.push(`body_content = $${paramIdx}`); values.push(input.body_content); paramIdx++; }
  if (input.font_family !== undefined) { setClauses.push(`font_family = $${paramIdx}`); values.push(input.font_family); paramIdx++; }
  if (input.font_size !== undefined) { setClauses.push(`font_size = $${paramIdx}`); values.push(input.font_size); paramIdx++; }
  if (input.footer_text !== undefined) { setClauses.push(`footer_text = $${paramIdx}`); values.push(input.footer_text); paramIdx++; }
  if (input.is_active !== undefined) { setClauses.push(`is_active = $${paramIdx}`); values.push(input.is_active); paramIdx++; }
  if (input.tenant_id !== undefined) { setClauses.push(`tenant_id = $${paramIdx}`); values.push(input.tenant_id); paramIdx++; }

  values.push(id);
  const { rows } = await pool.query(
    `UPDATE email_templates SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
    values
  );

  if (!rows[0]) throw new Error(`Failed to update email template: id=${id} not found`);
  return rows[0];
}

// Delete an email template by id
async function deleteEmailTemplate(id) {
  const pool = getPool();
  await pool.query('DELETE FROM email_templates WHERE id = $1', [id]);
  return { id };
}

// Return static default template definitions
function getDefaultTemplates() {
  return DEFAULT_TEMPLATES;
}

module.exports = {
  getEmailTemplates,
  getEmailTemplateById,
  getEmailTemplateByKey,
  createEmailTemplate,
  updateEmailTemplate,
  deleteEmailTemplate,
  getDefaultTemplates,
};
