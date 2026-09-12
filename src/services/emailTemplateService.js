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
    'SELECT * FROM email_templates WHERE id = $1',
    [id]
  );

  if (rows.length === 0) throw new Error('Email template not found');
  return rows[0];
}

// Fetch an active email template by template_key
async function getEmailTemplateByKey(templateKey) {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT * FROM email_templates WHERE template_key = $1 AND is_active = true',
    [templateKey]
  );

  if (rows.length === 0) throw new Error(`Email template not found for key "${templateKey}"`);
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

  const updatePayload = { updated_at: new Date().toISOString() };

  if (input.template_key !== undefined) updatePayload.template_key = input.template_key;
  if (input.name !== undefined) updatePayload.name = input.name;
  if (input.subject !== undefined) updatePayload.subject = input.subject;
  if (input.body_content !== undefined) updatePayload.body_content = input.body_content;
  if (input.font_family !== undefined) updatePayload.font_family = input.font_family;
  if (input.font_size !== undefined) updatePayload.font_size = input.font_size;
  if (input.footer_text !== undefined) updatePayload.footer_text = input.footer_text;
  if (input.is_active !== undefined) updatePayload.is_active = input.is_active;
  if (input.tenant_id !== undefined) updatePayload.tenant_id = input.tenant_id;

  const keys = Object.keys(updatePayload);
  const values = Object.values(updatePayload);
  const setClauses = keys.map((key, i) => `${key} = $${i + 1}`).join(', ');

  const { rows } = await pool.query(
    `UPDATE email_templates SET ${setClauses} WHERE id = $${keys.length + 1} RETURNING *`,
    [...values, id]
  );

  if (rows.length === 0) throw new Error('Failed to update email template: not found');
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
