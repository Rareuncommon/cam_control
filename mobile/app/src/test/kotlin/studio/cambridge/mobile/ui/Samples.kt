package studio.cambridge.mobile.ui

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import studio.cambridge.core.Studio

/** A studio as CamBridge describes it: three Sony bodies and five Lyra panels, as in scripts/mock-studio.mjs. */
object Samples {
    private fun options(vararg pairs: Pair<Int, String>) = pairs.joinToString(",", "[", "]") { (r, l) -> """{"raw":$r,"label":"$l"}""" }

    private fun cam(id: String, label: String, model: String, recording: Boolean, tally: String?, extra: String = "") = """
        {"id":"$id","label":"$label","model":"$model","kind":"cine","state":"connected",
         ${if (tally != null) "\"tally\":{\"$tally\":true}," else ""}
         ${if (recording) "\"recordStartedAt\":${System.currentTimeMillis() - 83_000}," else ""}
         "status":{"recording":$recording,"battery":${if (id == "fx30-b") 12 else 78},"mediaSlot1Sec":${if (id == "fx30-b") 420 else 7260}},
         "properties":{
           "fNumber":{"raw":400,"label":"f/4.0","writable":true,"options":${options(280 to "f/2.8", 400 to "f/4.0", 560 to "f/5.6")}},
           "isoSensitivity":{"raw":800,"label":"ISO 800","writable":true,"options":${options(400 to "ISO 400", 800 to "ISO 800", 1600 to "ISO 1600")}},
           "shutterSpeed":{"raw":50,"label":"1/50","writable":true,"options":${options(25 to "1/25", 50 to "1/50", 100 to "1/100")}},
           "colorTemp":{"raw":5600,"label":"5600K","writable":true,"range":{"min":2500,"max":9900,"step":100}},
           "whiteBalance":{"raw":1,"label":"Color Temp","writable":true,"options":${options(1 to "Color Temp", 2 to "Daylight", 3 to "Tungsten")}}
           $extra
         }}"""

    val studioJson = """{"type":"state",
      "view":{"camdConnected":true,"cameras":[
        ${cam("fx3", "Wide", "ILME-FX3", true, "program")},
        ${cam("fx30-a", "Close A", "ILME-FX30", false, "preview")},
        ${cam("fx30-b", "Close B", "ILME-FX30", false, null, extra = ""","shutterMode":{"raw":1,"label":"Auto","writable":true}""")},
        {"id":"fx6","label":"Overhead","model":"ILME-FX6","kind":"cine","state":"reconnecting","detail":"No answer from the camera for 12 s."}
      ]},
      "roll":{"total":3,"rolling":1,"all":false},
      "lighting":{
        "output":{"state":"dry-run","enabled":true,"dryRun":true},
        "known":true,
        "fixtures":[
          {"id":"l1","name":"L1 Key","live":true,"intensity":68.6,"cct":3341,"kelvin":{"min":3200,"max":5600}},
          {"id":"l2","name":"L2 Fill","live":true,"intensity":69.8,"cct":3341,"kelvin":{"min":3200,"max":5600}},
          {"id":"l3","name":"L3 Back","live":true,"intensity":7.8,"cct":3341,"kelvin":{"min":3200,"max":5600}},
          {"id":"l4","name":"L4 Hair","live":true,"intensity":11.8,"cct":3341,"kelvin":{"min":3200,"max":5600}},
          {"id":"l5","name":"L5 Background","live":true,"intensity":2.4,"cct":3341,"kelvin":{"min":3200,"max":5600}}
        ],
        "scenes":[
          {"slot":1,"name":"Interview","empty":false},{"slot":2,"name":"Two-shot","empty":false},
          {"slot":3,"name":"Scene 3","empty":true},{"slot":4,"name":"Scene 4","empty":true},{"slot":5,"name":"Scene 5","empty":true}
        ],
        "looks":[{"id":"studio","name":"Studio look","protected":true},{"id":"off","name":"Studio off","protected":true}],
        "active":{"type":"look","id":"studio"}
      }
    }"""

    val studio = Studio(Json.parseToJsonElement(studioJson).jsonObject)
}
