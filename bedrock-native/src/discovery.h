#pragma once
#include <cstdint>
#include <string>
// Learning the game from itself: MSVC RTTI names every polymorphic class in
// the running image, so objects can be told apart by class — and fields
// found by what they hold — without addresses from anyone else. The first
// step only reports what it finds next to what the adapter already knows.
namespace discovery {
// The image's classes (once): how many RTTI names, and the ones we care about.
std::string classes(uintptr_t imageBegin, uintptr_t imageEnd);
// In a world: what class each known object is, and where the fields the
// adapter reads would be found by their contents alone.
std::string world(uintptr_t client, uintptr_t actor, uintptr_t level, const std::string& name, float x, float y, float z);
}
