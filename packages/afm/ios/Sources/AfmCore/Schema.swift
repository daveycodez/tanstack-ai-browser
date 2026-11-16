import Foundation
import FoundationModels

/// A tool's parameters, or a structured answer's shape, as the adapter sends it: JSON
/// Schema already read into an ordered form (src/schema.ts), so a property keeps its
/// place (the model writes properties in the order it's given them). The kinds:
///
/// - `object`: `name`, `description`, `properties` ([{ name, description, optional, schema }])
/// - `array`: `items`, `minimumElements`, `maximumElements`
/// - `string`: `choices` (an enum), `constant`
/// - `integer`, `number`: `minimum`, `maximum`
/// - `boolean`, `null`
/// - `anyOf`: `name`, `description`, `choices` (schemas)
/// - `reference`: `name`, one of the definitions
@available(iOS 26.0, macOS 26.0, *)
enum Schema {
    struct Unsupported: Error, CustomStringConvertible {
        let description: String
    }

    /// A generation schema from a root and its definitions (the `reference` targets).
    static func generationSchema(_ value: Any?) throws -> GenerationSchema {
        let json = try object(value, "schema")
        let definitions = try (json["definitions"] as? [Any] ?? []).map(dynamicSchema)
        return try GenerationSchema(root: dynamicSchema(json["root"]), dependencies: definitions)
    }

    static func dynamicSchema(_ value: Any?) throws -> DynamicGenerationSchema {
        let json = try object(value, "schema")
        let kind = json["kind"] as? String ?? ""
        switch kind {
        case "object":
            let properties = try (json["properties"] as? [Any] ?? []).map { item -> DynamicGenerationSchema.Property in
                let property = try object(item, "property")
                return DynamicGenerationSchema.Property(
                    name: property["name"] as? String ?? "",
                    description: property["description"] as? String,
                    schema: try dynamicSchema(property["schema"]),
                    isOptional: property["optional"] as? Bool ?? false
                )
            }
            return DynamicGenerationSchema(name: json["name"] as? String ?? "object", description: json["description"] as? String, properties: properties)
        case "array":
            return DynamicGenerationSchema(
                arrayOf: try dynamicSchema(json["items"]),
                minimumElements: json["minimumElements"] as? Int,
                maximumElements: json["maximumElements"] as? Int
            )
        case "string":
            if let constant = json["constant"] as? String {
                return DynamicGenerationSchema(type: String.self, guides: [.constant(constant)])
            }
            if let choices = json["choices"] as? [String], !choices.isEmpty {
                return DynamicGenerationSchema(type: String.self, guides: [.anyOf(choices)])
            }
            return DynamicGenerationSchema(type: String.self)
        case "integer":
            let minimum = (json["minimum"] as? NSNumber)?.intValue, maximum = (json["maximum"] as? NSNumber)?.intValue
            var guides: [GenerationGuide<Int>] = []
            if let minimum, let maximum { guides.append(.range(minimum...max(minimum, maximum))) }
            else if let minimum { guides.append(.minimum(minimum)) }
            else if let maximum { guides.append(.maximum(maximum)) }
            return DynamicGenerationSchema(type: Int.self, guides: guides)
        case "number":
            let minimum = (json["minimum"] as? NSNumber)?.doubleValue, maximum = (json["maximum"] as? NSNumber)?.doubleValue
            var guides: [GenerationGuide<Double>] = []
            if let minimum, let maximum { guides.append(.range(minimum...max(minimum, maximum))) }
            else if let minimum { guides.append(.minimum(minimum)) }
            else if let maximum { guides.append(.maximum(maximum)) }
            return DynamicGenerationSchema(type: Double.self, guides: guides)
        case "boolean":
            return DynamicGenerationSchema(type: Bool.self)
        case "null":
            if #available(iOS 26.4, macOS 26.4, *) { return .null }
            throw Unsupported(description: "A null schema needs iOS 26.4 or macOS 26.4")
        case "anyOf":
            let choices = try (json["choices"] as? [Any] ?? []).map(dynamicSchema)
            return DynamicGenerationSchema(name: json["name"] as? String ?? "choice", description: json["description"] as? String, anyOf: choices)
        case "reference":
            return DynamicGenerationSchema(referenceTo: json["name"] as? String ?? "")
        default:
            throw Unsupported(description: "Unknown schema kind \"\(kind)\"")
        }
    }

    static func object(_ value: Any?, _ what: String) throws -> [String: Any] {
        guard let object = value as? [String: Any] else { throw Unsupported(description: "Expected a \(what) object") }
        return object
    }
}
