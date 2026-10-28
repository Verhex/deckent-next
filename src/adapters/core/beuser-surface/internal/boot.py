"""Validate the packaged private boot schema before either driver can launch."""
import json
import os
import re


def validate(value, schema):
    # Only this version's schema vocabulary is supported. New keywords fail closed.
    if set(schema) - {'$schema', 'type', 'const', 'enum', 'properties', 'required',
                      'additionalProperties', 'items', 'minItems', 'minLength',
                      'minimum', 'maximum', 'pattern'}:
        raise ValueError()
    kind = schema['type']
    expected = {'object': dict, 'array': list, 'integer': int, 'string': str}[kind]
    if type(value) is not expected:
        raise ValueError()
    if 'const' in schema and value != schema['const']:
        raise ValueError()
    if 'enum' in schema and value not in schema['enum']:
        raise ValueError()
    if kind == 'object':
        if not set(schema.get('required', [])).issubset(value):
            raise ValueError()
        properties = schema.get('properties', {})
        for key, member in value.items():
            child = properties.get(key, schema.get('additionalProperties', False))
            if child is False:
                raise ValueError()
            validate(member, child)
    elif kind == 'array':
        if len(value) < schema.get('minItems', 0):
            raise ValueError()
        for member in value:
            validate(member, schema['items'])
    elif kind == 'string':
        if len(value) < schema.get('minLength', 0) or ('pattern' in schema and not re.search(schema['pattern'], value)):
            raise ValueError()
    elif value < schema.get('minimum', value) or value > schema.get('maximum', value):
        raise ValueError()


def read_boot(line):
    with open(os.path.join(os.path.dirname(__file__), 'boot.schema.json'), encoding='utf8') as source:
        schema = json.load(source)
    boot = json.loads(line)
    validate(boot, schema)
    limits = boot['limits']
    if not (limits['quietMs'] <= limits['inactivityMs'] <= limits['maxWaitMs'] <= limits['maxWallMs']
            and limits['cleanupDeadlineMs'] <= limits['maxWallMs']
            and limits['maxInputBytes'] <= boot['maxArtifactBytes']
            and boot['columns'] * boot['rows'] * 4 <= boot['maxArtifactBytes']):
        raise ValueError()
    return boot
