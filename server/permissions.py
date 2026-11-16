"""Project memberships and the roles that grant business permissions."""

import json

BUSINESS_ROLES = ('engineering', 'purchasing', 'warehouse', 'inspection', 'shipping')
PROJECT_ROLES = ('lead', *BUSINESS_ROLES)

# NULL identifies a membership created before roles were assigned. Keep its
# existing editing rights until an administrator or project lead configures it.
def project_roles(db, project, user):
    row = db.execute('''SELECT p.owner_id,m.user_id,m.roles FROM projects p
        LEFT JOIN project_members m ON m.project_id=p.id AND m.user_id=?
        WHERE p.id=? AND p.deleted_at IS NULL''', (user['id'], project)).fetchone()
    if not row:
        return []
    if user['role'] == 'admin' or row['owner_id'] == user['id']:
        return ['lead']
    if row['user_id'] is None:
        return []
    return json.loads(row['roles']) if row['roles'] is not None else ['legacy']


def can(db, project, user, role, *, delegated=False):
    roles = project_roles(db, project, user)
    return ('lead' in roles or role in roles or
            ('legacy' in roles and role in BUSINESS_ROLES and not delegated))


def can_import_shopify(user):
    return user['role'] == 'admin' or bool(dict(user).get('shopify_import'))


def membership_allows(role, member='m', project='j'):
    """SQL for ordinary business access inside a project-membership query."""
    assert role in BUSINESS_ROLES
    return f"""({member}.roles IS NULL OR {project}.owner_id={member}.user_id OR EXISTS (
        SELECT 1 FROM json_each({member}.roles) WHERE value IN ('lead','{role}')))"""
