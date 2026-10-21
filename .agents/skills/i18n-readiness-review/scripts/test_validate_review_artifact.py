"""Contract tests using complete paired request/result records; no external dependencies."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from validate_review_artifact import CLASSIFICATIONS, validate_review_artifact


def fixture(classification='no_issue_detected'):
    unit = dict(unit_id='save', source='Save', current_target='保存', protected_terms=[], automatic_checks=[])
    req = dict(schema_version=2, review_id='test', source_locale='en', targets=[dict(
        target_locale='zh-CN', review_depth='single', selected_capabilities=['translation-qa'],
        missing_capabilities=[], runtime_ui_review=dict(decision='skip', required=False,
        reasons=['no-applicable-runtime-surface']), units=[unit])])
    issue = dict(dimension='semantic', issue='Action mistranslated', owner='unassigned', affected_segment='保存')
    result_unit = dict(unit_id='save', source='Save', current_target='保存', classification=classification,
        primary=dict(issues=[issue] if classification=='change_recommended' else [], confidence='high',
                     native_review_required=False, native_review_reason=None), challenge=None,
        adjudication=dict(status='not_required', rationale=None), recommendation=None, recommendation_qa=None,
        source_issue=dict(issue='Ambiguous source', blocks_decision=True) if classification=='blocked_by_source' else None,
        human_review=dict(status='not_requested', decision=None, correction=None, notes=None, severity=None, reviewer=None))
    res = dict(schema_version=2, review_id='test', source_locale='en', locales=[dict(
        target_locale='zh-CN', review_depth='single', execution_mode='sequential',
        selected_capabilities=['translation-qa'], missing_capabilities=[],
        runtime_ui_review=dict(status='not_applicable', reason='Static text only', evidence=[]), units=[result_unit])],
        summary=dict(locales=1, units=1, counts={k:int(k==classification) for k in CLASSIFICATIONS}))
    return req,res


class ContractTests(unittest.TestCase):
    def valid(self, pair): self.assertEqual(validate_review_artifact(*pair), ())
    def invalid(self, pair, fragment):
        errors=validate_review_artifact(*pair)
        self.assertTrue(any(fragment in e for e in errors), errors)
    def unit(self,pair): return pair[1]['locales'][0]['units'][0]
    def test_all_classifications_without_correction(self):
        for c in CLASSIFICATIONS:
            with self.subTest(c=c): self.valid(fixture(c))
    def test_candidate_and_qa(self):
        p=fixture('change_recommended');u=self.unit(p)
        u['recommendation']=dict(text='储存',owner='unassigned')
        u['recommendation_qa']=dict(status='passed',issues=[]);self.valid(p)
        u['recommendation_qa']=None;self.invalid(p,'requires recommendation_qa')
    def test_qa_without_candidate(self):
        p=fixture('change_recommended');self.unit(p)['recommendation_qa']=dict(status='passed',issues=[])
        self.invalid(p,'must be null without')
    def test_failed_candidate(self):
        p=fixture('change_recommended');u=self.unit(p)
        u['recommendation']=dict(text='储存',owner='unassigned');u['recommendation_qa']=dict(status='unresolved',issues=['term unknown'])
        self.invalid(p,'must be passed')
        u['classification']='unresolved';p[1]['summary']['counts'].update(change_recommended=0,unresolved=1);self.valid(p)
    def test_false_no_issue(self):
        p=fixture('change_recommended');self.unit(p)['classification']='no_issue_detected'
        self.invalid(p,'empty accepted issue set')
    def test_source_blocker(self):
        p=fixture('blocked_by_source');self.unit(p)['source_issue']['blocks_decision']=False
        self.invalid(p,'must be true')
    def test_human_pending_independent(self):
        p=fixture();self.unit(p)['human_review']['status']='pending';self.valid(p)
        self.unit(p)['human_review']['reviewer']='invented';self.invalid(p,'unless human review is completed')
    def test_runtime_unavailable(self):
        p=fixture();p[0]['targets'][0]['runtime_ui_review']=dict(decision='run',required=True,reasons=['UI requested'])
        p[1]['locales'][0]['runtime_ui_review']=dict(status='unavailable',reason='No environment',evidence=[]);self.valid(p)
        p[1]['locales'][0]['runtime_ui_review'].update(status='completed',reason=None)
        self.invalid(p,'requires evidence')
    def test_source_less_rejected_not_fabricated(self):
        p=fixture();del p[0]['targets'][0]['units'][0]['source'];self.invalid(p,'source')
    def test_duplicate_and_missing_units(self):
        p=fixture();p[1]['locales'][0]['units']*=2;self.invalid(p,'duplicate unit')
        p=fixture();p[1]['locales'][0]['units']=[];self.invalid(p,'missing unit')
    def test_joint_report_cannot_pollute_translation_record(self):
        p=fixture();p[1]['engineering']={'ready':True};self.invalid(p,'engineering')
    def test_protected_terms_enforced(self):
        p=fixture();p[0]['targets'][0]['units'][0]['protected_terms']=['Compass']
        p[0]['targets'][0]['units'][0]['source']='Save Compass'
        self.unit(p)['source']='Save Compass'
        self.invalid(p,'protected')
    def test_challenge_coverage(self):
        p=fixture()
        for x in [p[0]['targets'][0],p[1]['locales'][0]]: x['review_depth']='full_challenge'
        self.invalid(p,'challenge is required')
        self.unit(p)['challenge']=copy.deepcopy(self.unit(p)['primary']);self.valid(p)
    def test_summary_and_unknown_fields(self):
        p=fixture();p[1]['summary']['units']=2;self.invalid(p,'derived value')
        p=fixture();self.unit(p)['unexpected']=True;self.invalid(p,'unexpected')
    def test_cli_valid_and_duplicate_json(self):
        script=Path(__file__).with_name('validate_review_artifact.py')
        with tempfile.TemporaryDirectory() as d:
            a,b=Path(d)/'req.json',Path(d)/'res.json';req,res=fixture()
            a.write_text(json.dumps(req));b.write_text(json.dumps(res))
            cmd=[sys.executable,str(script),'--request',str(a),'--result',str(b)]
            run=subprocess.run(cmd,capture_output=True,text=True)
            self.assertEqual(run.returncode,0,run.stderr);self.assertTrue(json.loads(run.stdout)['valid'])
            a.write_text('{"x":1,"x":2}')
            run=subprocess.run(cmd,capture_output=True,text=True)
            self.assertEqual(run.returncode,2);self.assertIn('duplicate JSON key',run.stderr)

if __name__=='__main__': unittest.main()
