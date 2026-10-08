import math
from pathlib import Path
import sys
import unittest

import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from bev_tracker import _LaneTrack, _Track, smooth_timeline, ego_translation
from reconstruct_bev import estimate_box_center, _merge_cross_camera_observations, deduplicate_objects
from validate_bev_timeline import analyse_payload, quality_gate


def detection(x=0, z=20):
    return dict(x=x, z=z, kind='vehicle', width=1.9, length=4.5, confidence=.9,
                heading=0, camera='front', rangeSource='moge2', observations=[dict(camera='front', imageBox=[0,0,20,20])])


class GeometryRegressionTests(unittest.TestCase):
    def test_same_speed_following_keeps_relative_distance(self):
        track = _Track('car', detection(), 25)
        track.predict(.5,12.5,0)
        self.assertAlmostEqual(track.z,20)

    def test_stationary_object_moves_back_as_ego_advances(self):
        track = _Track('car', detection(), 0)
        track.predict(.5,5,0)
        self.assertAlmostEqual(track.z,15)

    def test_turn_compensates_static_lane(self):
        points = np.array([[1.85,4],[1.85,8],[1.85,16],[1.85,30]])
        lane = _LaneTrack(points)
        lane.predict(0,math.radians(5))
        self.assertAlmostEqual(lane.points[-1,0],1.85*math.cos(math.radians(5))-30*math.sin(math.radians(5)))
        self.assertFalse(np.allclose(lane.points,points))

    def test_arc_translation_is_consistent(self):
        result = ego_translation(math.pi/2*10, math.pi/2)
        np.testing.assert_allclose(result,[10,10])

    def test_curvature_survives_and_support_is_not_extended(self):
        zs=np.linspace(4,45,40)
        points=np.column_stack([1.85+.004*(zs-8)**2,zs])
        lane=_LaneTrack(points)
        output=np.array(lane.polyline())
        self.assertAlmostEqual(output[0,1],4)
        self.assertAlmostEqual(output[-1,1],45)
        self.assertGreater(abs(output[0,0]+output[-1,0]-2*output[len(output)//2,0]),2)

    def test_history_behind_ego_comes_from_previous_observations(self):
        lane=_LaneTrack(np.array([[1.85,4],[1.85,10],[1.85,20],[1.85,40]]))
        lane.predict(10,0)
        lane.update(np.array([[1.85,4],[1.85,15],[1.85,40]]))
        self.assertEqual(lane.points[0,1],-6)
        self.assertEqual(lane.observed_range,[4,40])

    def test_surface_to_center_respects_view_direction(self):
        self.assertAlmostEqual(estimate_box_center((0,10),(0,0),1.9,4.5,0)[1],12.25)
        self.assertAlmostEqual(estimate_box_center((0,-10),(0,0),1.9,4.5,0)[1],-12.25)
        self.assertAlmostEqual(estimate_box_center((10,0),(0,0),1.9,4.5,0)[0],10.95)

    def test_fusion_and_tracking_keep_each_camera_observation(self):
        first=detection();second=detection(.1,20.2)
        second['camera']='rightPillar';second['observations'][0]['camera']='rightPillar'
        _merge_cross_camera_observations(first,second)
        track=_Track('car',first)
        self.assertEqual(len(track.to_object()['observations']),2)

    def test_fusion_never_combines_two_cars_from_one_camera(self):
        first=detection(-6,10); first.update(camera='left',confidence=.95,imageBox=[0,0,50,50])
        second=detection(-6.1,10); second.update(camera='leftPillar',confidence=.9,imageBox=[0,0,50,50])
        third=detection(-6.2,10); third.update(camera='leftPillar',confidence=.8,imageBox=[100,0,150,50])
        for d in [first,second,third]: d['observations'][0]['camera']=d['camera']
        result=deduplicate_objects([first,second,third])
        self.assertEqual(len(result),2)
        for item in result:
            cameras=[o['camera'] for o in item['observations']]
            self.assertEqual(len(cameras),len(set(cameras)))

    def test_lane_topology_retains_boundaries_across_missing_lane(self):
        from bev_tracker import _select_lane_topology
        lanes=[_LaneTrack(np.array([[x,4],[x,30]],dtype=float)) for x in [-5.5,1.9]]
        self.assertEqual(len(_select_lane_topology(lanes)),2)

    def test_lane_id_survives_missing_observation_and_turn(self):
        lane=[[1.85,z] for z in [4,8,16,30]]
        frames=[dict(timeSec=t,objects=[],lanes=[lane] if t<2 else []) for t in range(3)]
        samples=[dict(time_sec=t,vehicle_speed_mps=0,heading_deg=5 if t==2 else 0) for t in range(3)]
        smooth_timeline(frames,samples)
        self.assertEqual(frames[1]['laneIds'],frames[2]['laneIds'])
        self.assertTrue(frames[2]['laneStates'][0]['predicted'])
        self.assertLess(frames[2]['lanes'][0][-1][0],0)

    def test_empty_result_not_marked_ready(self):
        frames=[dict(timeSec=t,objects=[],lanes=[]) for t in range(2)]
        result=quality_gate(analyse_payload(dict(frames=frames,rangeBackend='moge2',calibrated=True)))
        self.assertFalse(result['passed'])
        self.assertTrue(result['structuralPassed'])
        self.assertEqual(result['observationCoverage'],'none')

    def test_malformed_geometry_reports_error_instead_of_crashing(self):
        for bad in [dict(x=float('nan')),dict(x=0,z=0,width=-1,length=4,confidence=.9,heading=0)]:
            result=analyse_payload(dict(frames=[dict(timeSec=0,objects=[bad],lanes=[])]))
            self.assertIn('error',result)
        result=analyse_payload(dict(frames=[dict(timeSec=0,objects=[],lanes=[[[0,0],[None,1]]])]))
        self.assertIn('error',result)

    def test_structural_pass_does_not_claim_metric_accuracy(self):
        frames=[dict(timeSec=t,objects=[],lanes=[[[1.85,4],[1.85,20]]]) for t in range(2)]
        gate=quality_gate(analyse_payload(dict(frames=frames,rangeBackend='moge2',calibrated=True)))
        self.assertTrue(gate['passed'])
        self.assertFalse(gate['geometryVerified'])

if __name__=='__main__': unittest.main()
