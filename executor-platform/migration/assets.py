"""Projection from the Workbench store to the standalone store. No filesystem I/O."""
import re
import uuid


class Refused(ValueError):
    pass


def require(condition, reason="管理记录形状不受支持"):
    if not condition:
        raise Refused(reason)


def obj(value):
    require(isinstance(value, dict))
    return value


def fields(row, allowed, required=()):
    keys = obj(row).keys()
    require(keys <= set(allowed.split()) and set(required) <= keys)


def table(row, key):
    return obj(obj(row).get(key, {}))


def array(value):
    require(isinstance(value, list))
    return value


def uid(s):
    require(isinstance(s, str) and re.fullmatch('[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}', s)
            and str(uuid.UUID(s)) == s, '需要小写标准 UUID')


def name(s):
    require(isinstance(s, str) and len(s.encode()) <= 128 and s not in ('.', '..')
            and re.fullmatch(r'[\w.-]+', s), '需要无路径的名称')


def revision(n):
    require(type(n) is int and 0 < n < 2**64)


def strings(value):
    if isinstance(value, dict):
        for k, v in value.items():
            yield k
            yield from strings(v)
    elif isinstance(value, list):
        for v in value:
            yield from strings(v)
    elif isinstance(value, str):
        yield value


def settings(value):
    fields(value, 'modelProfile tools mcpServers')
    require(value.get('mcpServers', {}) == {}, 'mcp.json 包含内联服务，须改为平台命名引用')
    if 'modelProfile' in value:
        name(value['modelProfile'])
    for tool in array(value.get('tools', [])):
        name(tool)


def config_schema(value):
    if isinstance(value, dict):
        fields(value, 'fields', ['fields'])
        value = value['fields']
    for field in array(value):
        fields(field, 'key label description type required default options min max', ['key', 'type'])
        name(field['key'])
        for option in array(field.get('options', [])):
            fields(option, 'value label', ['value', 'label'])
            require(all(isinstance(x, str) for x in option.values()))
        for k, v in field.items():
            if k not in ('default', 'options'):
                require(not isinstance(v, (dict, list)))
        if 'default' in field:
            v = field['default']
            if field['type'] == 'secret':
                require(v == '***' or v == {'redacted': True} or
                        (isinstance(v, dict) and set(v) == {'ref'} and isinstance(v['ref'], str)
                         and re.fullmatch(r'secret://[^/\s][^\s]*', v['ref'])), '拒绝明文 secret 默认值')
            else:
                require(not isinstance(v, (dict, list)))


def snapshot(value):
    fields(value, 'systemPrompt modelProfile skills tools', ['systemPrompt', 'modelProfile', 'skills', 'tools'])
    require(isinstance(value['systemPrompt'], str))
    name(value['modelProfile'])
    for skill in array(value['skills']):
        fields(skill, 'id revision content', ['id', 'revision', 'content'])
        name(skill['id'])
        revision(skill['revision'])
        require(isinstance(skill['content'], str))
    for tool in array(value['tools']):
        fields(tool, 'id schemaDigest', ['id', 'schemaDigest'])
        name(tool['id'])
        require(isinstance(tool['schemaDigest'], str) and re.fullmatch('[0-9a-f]{64}', tool['schemaDigest']))


def validate_catalog(catalog, packages):
    for kind, rows in catalog.items():
        for key, row in rows.items():
            name(key)
            fields(row, ('active revisions agentSnapshots agentBindings' if kind == 'executors' else
                         'active revisions'), ['active', 'revisions'])
            require(isinstance(row['active'], bool) and array(row['revisions']))
            agents = set()
            for r, v in enumerate(row['revisions'], 1):
                require(obj(v).get('id') == key and type(v.get('revision')) is int and v['revision'] == r,
                        '修订号或定义 ID 不匹配')
                if kind == 'resources':
                    fields(v, 'id revision kind content', ['kind', 'content'])
                    if v['kind'] == 'mcp':
                        fields(v['content'], 'serverRef credentialRef', ['serverRef'])
                        for x in v['content'].values():
                            name(x)
                    else:
                        require(v['kind'] in ('prompt', 'skill') and isinstance(v['content'], str))
                    continue
                fields(v, 'id revision agent resources configSchema')
                for ref in array(v.get('resources', [])):
                    fields(ref, 'id revision', ['id', 'revision'])
                    name(ref['id'])
                    revision(ref['revision'])
                    require(ref['revision'] <= len(catalog['resources'].get(ref['id'], {}).get('revisions', [])),
                            '引用的资源修订不存在')
                if 'configSchema' in v:
                    config_schema(v['configSchema'])
                if 'agent' not in v:
                    continue
                agent = obj(v['agent'])
                if 'configPackageId' in agent:
                    fields(agent, 'configPackageId backendId')
                    require(isinstance(agent['configPackageId'], str) and agent['configPackageId'] in packages,
                            'Agent 引用的配置包不存在')
                else:  # Historical inline Pi definitions also resolve using agentSnapshots.
                    fields(agent, 'systemPrompt modelProfile tools', ['systemPrompt', 'modelProfile'])
                    require(isinstance(agent['systemPrompt'], str))
                    settings({k: x for k, x in agent.items() if k != 'systemPrompt'})
                s = str(r)
                agents.add(s)
                snapshot(table(row, 'agentSnapshots').get(s))
                bindings = table(row, 'agentBindings')
                if 'backendId' in agent or s in bindings:
                    b = bindings.get(s)
                    name(agent.get('backendId', 'pi'))
                    require(isinstance(b, list) and len(b) == 3 and b[0] == agent.get('backendId', 'pi')
                            and all(isinstance(x, str) and x.startswith('/') for x in b[1:]),
                            '发布修订缺少原后端绑定或绑定不匹配')
            require(table(row, 'agentSnapshots').keys() == agents and table(row, 'agentBindings').keys() <= agents,
                    '快照或绑定引用无效')


def project(db):
    source_catalog = table(db, 'catalog')
    require(not ({'items', 'configPackageSnapshots'} & db.keys() or 'packages' in source_catalog),
            '检测到退役派工库，请先在隔离副本完成旧版升级')
    require(not table(db, 'executorAttemptOwners'), '源库含平台 attempt 所有权记录')
    tombstones = {}
    for key, row in table(db, 'executorAttempts').items():
        uid(key)
        result = table(row, 'result')
        require(result.get('status') in ('succeeded', 'failed', 'cancelled'),
                f'attempt {key} 活跃、待核实或状态未知')
        require(result.get('attemptId') == key, 'attempt ID 不匹配')
        uid(result.get('artifactDirectoryId'))  # Terminal publication committed, not just backendStatus.
        # access::start refuses an existing row without an owner. Do not import the request,
        # artifacts or credentials and do not allow a client to claim/restart a historical ID.
        tombstones[key] = {'result': {'attemptId': key, 'status': result['status']}}

    packages, dirs = table(db, 'configPatches'), {}
    for key, patch in packages.items():
        uid(key)
        fields(patch, 'id name directoryId', ['id', 'name', 'directoryId'])
        require(patch['id'] == key and isinstance(patch['name'], str))
        d = patch['directoryId']
        uid(d)
        require(d not in dirs, '多个配置包共享目录')
        rec = table(db, 'directories').get(d)
        fields(rec, 'id rules state', ['id', 'rules'])
        require(rec['id'] == d and rec.get('state', 'writable') == 'writable')
        rules = rec['rules']
        fields(rules, 'fixed json_objects', ['fixed', 'json_objects'])
        require(sorted(array(rules['fixed'])) == ['AGENTS.md', 'mcp.json', 'skills']
                and rules['json_objects'] == ['mcp.json'], '配置目录规则不匹配')
        dirs[d] = rec
    catalog = {k: table(source_catalog, k) for k in ('resources', 'executors')}
    validate_catalog(catalog, packages)
    # Unknown namespaces are never exported. A second reference to a selected directory
    # outside its owning assets makes ownership ambiguous (including generation outputs).
    other = [v for k, v in db.items() if k not in ('catalog', 'configPatches', 'directories')]
    other.extend(v for k, v in source_catalog.items() if k not in catalog)
    require(not any(s in dirs for s in strings(other)), '配置目录也被业务或尝试记录引用')
    out = {'configPatches': packages, 'directories': dirs, 'catalog': catalog}
    if tombstones:
        out['executorAttempts'] = tombstones
    return out
