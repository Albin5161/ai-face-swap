"""Print how many faces FaceFusion sees in each image path given as an argument.

Run with FaceFusion's Python, from inside the FaceFusion folder:
    python count_faces.py source.jpg target.jpg
The last line of output is a JSON list of counts, one per path.
"""
import json
import os
import sys

sys.path.insert(0, os.getcwd())

from facefusion import face_classifier, face_detector, face_landmarker, face_recognizer, state_manager
from facefusion.face_analyser import get_many_faces
from facefusion.vision import read_static_image

state_manager.init_item('execution_device_ids', [ 0 ])
state_manager.init_item('execution_providers', [ 'cpu' ])
state_manager.init_item('download_providers', [ 'github' ])
state_manager.init_item('face_detector_angles', [ 0 ])
state_manager.init_item('face_detector_model', 'yolo_face')
state_manager.init_item('face_detector_size', '640x640')
state_manager.init_item('face_detector_margin', (0, 0, 0, 0))
state_manager.init_item('face_detector_score', 0.5)
state_manager.init_item('face_landmarker_model', '2dfan4')
state_manager.init_item('face_landmarker_score', 0.5)

counts = []

for image_path in sys.argv[1:]:
	vision_frame = read_static_image(image_path)
	counts.append(len(get_many_faces([ vision_frame ])))

print(json.dumps(counts))
