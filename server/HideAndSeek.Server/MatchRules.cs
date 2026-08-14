namespace HideAndSeek.Server;

/// <summary>
/// Catch / LOS constants and arena AABBs mirrored from the Babylon client arena.
/// </summary>
public static class MatchRules
{
    public const int HideSeconds = 12;
    public const int SeekSeconds = 45;
    public const double PoseHz = 15;
    public const double CatchRange = 1.6;
    public const double SightRange = 22;
    public const double MinSightDot = 0.35;
    public const double SeekerEyeY = 1.4;
    public const double HiderEyeY = 1.6;
    public const double SeekerCrouchEyeY = 0.85;
    public const double HiderCrouchEyeY = 0.95;

    private static readonly Aabb[] Obstacles = BuildObstacles();

    public static bool TryCatch(in Pose seeker, in Pose hider, out bool spotted)
    {
        var dx = hider.X - seeker.X;
        var dz = hider.Z - seeker.Z;
        var dist = Math.Sqrt(dx * dx + dz * dz);
        spotted = false;

        if (dist > SightRange || dist < 0.05)
        {
            return false;
        }

        var inv = 1.0 / dist;
        var dirX = dx * inv;
        var dirZ = dz * inv;
        var forwardX = Math.Sin(seeker.Yaw);
        var forwardZ = Math.Cos(seeker.Yaw);
        if (forwardX * dirX + forwardZ * dirZ < MinSightDot)
        {
            return false;
        }

        var seekerEye = seeker.Crouch ? SeekerCrouchEyeY : SeekerEyeY;
        var hiderEye = hider.Crouch ? HiderCrouchEyeY : HiderEyeY;
        if (!HasLineOfSight(seeker.X, seeker.Z, seekerEye, hider.X, hider.Z, hiderEye))
        {
            return false;
        }

        spotted = true;
        return dist < CatchRange;
    }

    private static bool HasLineOfSight(
        double sx, double sz, double sy,
        double hx, double hz, double hy)
    {
        var origin = new Vec3(sx, sy, sz);
        var target = new Vec3(hx, hy, hz);
        var dx = target.X - origin.X;
        var dy = target.Y - origin.Y;
        var dz = target.Z - origin.Z;
        var maxDist = Math.Sqrt(dx * dx + dy * dy + dz * dz);
        if (maxDist < 0.2)
        {
            return true;
        }

        var inv = 1.0 / maxDist;
        var dir = new Vec3(dx * inv, dy * inv, dz * inv);

        foreach (var box in Obstacles)
        {
            if (RayHitsAabb(origin, dir, maxDist - 0.5, box))
            {
                return false;
            }
        }

        return true;
    }

    private static bool RayHitsAabb(Vec3 origin, Vec3 dir, double maxDist, Aabb box)
    {
        var tMin = 0.0;
        var tMax = maxDist;

        if (!Slab(origin.X, dir.X, box.MinX, box.MaxX, ref tMin, ref tMax)) return false;
        if (!Slab(origin.Y, dir.Y, box.MinY, box.MaxY, ref tMin, ref tMax)) return false;
        if (!Slab(origin.Z, dir.Z, box.MinZ, box.MaxZ, ref tMin, ref tMax)) return false;

        return tMax >= tMin && tMax >= 0;
    }

    private static bool Slab(double origin, double dir, double min, double max, ref double tMin, ref double tMax)
    {
        if (Math.Abs(dir) < 1e-8)
        {
            return origin >= min && origin <= max;
        }

        var inv = 1.0 / dir;
        var t1 = (min - origin) * inv;
        var t2 = (max - origin) * inv;
        if (t1 > t2)
        {
            (t1, t2) = (t2, t1);
        }

        tMin = Math.Max(tMin, t1);
        tMax = Math.Min(tMax, t2);
        return tMin <= tMax;
    }

    private static Aabb[] BuildObstacles()
    {
        var list = new List<Aabb>
        {
            Box(0, 19.5, 40, 4, 1),
            Box(0, -19.5, 40, 4, 1),
            Box(19.5, 0, 1, 4, 40),
            Box(-19.5, 0, 1, 4, 40),
        };

        // Cover props — same layouts as src/arena.ts
        (double x, double z, double w, double h, double d)[] cover =
        [
            (-8, -6, 3, 2.2, 1.2),
            (-4, 4, 1.4, 2.8, 4),
            (2, -8, 5, 1.8, 1.4),
            (7, 2, 1.6, 2.4, 3.5),
            (-12, 8, 4, 2, 1.5),
            (10, -10, 2, 2.6, 2),
            (0, 10, 6, 1.6, 1.2),
            (12, 10, 1.5, 3, 5),
            (-2, -2, 2.2, 2, 2.2),
        ];

        foreach (var c in cover)
        {
            list.Add(Box(c.x, c.z, c.w, c.h, c.d));
        }

        return list.ToArray();
    }

    private static Aabb Box(double x, double z, double w, double h, double d) =>
        new(x - w / 2, 0, z - d / 2, x + w / 2, h, z + d / 2);

    private readonly record struct Vec3(double X, double Y, double Z);

    private readonly record struct Aabb(
        double MinX, double MinY, double MinZ,
        double MaxX, double MaxY, double MaxZ);
}

public readonly record struct Pose(double X, double Y, double Z, double Yaw, bool Crouch = false)
{
    public bool IsSet { get; init; }

    public static Pose Empty => default;

    public static Pose From(double x, double y, double z, double yaw, bool crouch = false) =>
        new(x, y, z, yaw, crouch) { IsSet = true };
}
